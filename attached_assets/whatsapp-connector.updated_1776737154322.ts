/**
 * ============================================================
 *  WHATSAPP CONNECTOR — Vinculación por Código de 8 Dígitos
 *  Archivo de referencia auto-contenido
 * ============================================================
 *
 * DESCRIPCIÓN GENERAL
 * -------------------
 * Este archivo conecta tu backend Node.js a WhatsApp usando la librería
 * Baileys (@whiskeysockets/baileys). A diferencia del método con QR,
 * este usa el código de emparejamiento de 8 dígitos (Linked Devices).
 *
 * DEPENDENCIAS NECESARIAS (instalar con pnpm/npm/yarn):
 * ------------------------------------------------------
 *   @whiskeysockets/baileys   → Librería principal de WhatsApp Web
 *   @hapi/boom                → Manejo de errores HTTP (peer dep de baileys)
 *   node-cache                → Caché en memoria para reintentos de mensajes
 *   node-cron                 → Programación de tareas (para estados automáticos)
 *   pino                      → Logger compatible con Baileys (OBLIGATORIO)
 *
 *   npm install @whiskeysockets/baileys @hapi/boom node-cache node-cron pino
 *
 * CÓMO USAR (ejemplo básico en tu backend):
 * ------------------------------------------
 *
 *   import { WhatsAppConnector } from './whatsapp-connector'
 *
 *   const wa = new WhatsAppConnector({ phoneNumber: '521234567890' })
 *
 *   // 1. Solicita el código (esto dispara la notificación en el teléfono)
 *   const code = await wa.requestPairingCode()
 *   console.log('Código:', code)  // → 'ABCD-1234'
 *
 *   // 2. El usuario aprueba en el teléfono WhatsApp → Dispositivos vinculados
 *   // 3. El usuario ingresa el código en WhatsApp
 *
 *   // Cuando ya está conectado:
 *   wa.on('connected', async () => {
 *     // Subir estado de texto
 *     await wa.uploadStatus({ type: 'text', caption: 'Hola mundo!', backgroundColor: '#25D366' })
 *
 *     // Subir estado de imagen
 *     await wa.uploadStatus({ type: 'image', filePath: '/ruta/imagen.jpg', caption: 'Mi foto' })
 *
 *     // Programar estado diario a las 9 AM
 *     wa.scheduleStatus('0 9 * * *', { type: 'text', caption: 'Buenos días!' })
 *   })
 *
 * NOTAS IMPORTANTES PARA EL BACKEND:
 * -----------------------------------
 * 1. La sesión se guarda en `wa-session/` (archivos JSON). No borres esa carpeta
 *    si quieres que la conexión persista entre reinicios del servidor.
 *
 * 2. El logger de Baileys DEBE ser una instancia de pino con level: 'silent'.
 *    NO pases undefined o un logger custom sin el método .child() — el proceso
 *    crasheará con "Cannot read properties of undefined (reading 'child')".
 *
 * 3. Para estados de texto con color de fondo, el color va en el TERCER parámetro
 *    de sendMessage (options), no en el contenido del mensaje. Baileys lo convierte
 *    internamente de hex string a ARGB.
 *
 * 4. El código de emparejamiento solo funciona si la cuenta NO tiene sesión activa.
 *    Si ya hay una sesión guardada, simplemente reconecta sin pedir código.
 *
 * 5. Si el usuario hace logout en el teléfono, borra la carpeta `wa-session/` y
 *    vuelve a solicitar un nuevo código de emparejamiento.
 *
 * 6. WhatsApp puede bloquear cuentas que envíen muchos mensajes/estados en poco
 *    tiempo. Usa los estados con moderación y no hagas spam.
 *
 * EVENTOS DISPONIBLES (EventEmitter):
 * ------------------------------------
 *   wa.on('connected', () => {})           → WhatsApp conectado
 *   wa.on('disconnected', ({ statusCode, shouldReconnect }) => {}) → Desconectado
 *   wa.on('connecting', () => {})          → Intentando conectar
 *   wa.on('pairingCode', (code) => {})     → Código de 8 dígitos generado
 *   wa.on('alreadyRegistered', () => {})   → Sesión activa existente
 *   wa.on('statusUploaded', (opts) => {})  → Estado subido con éxito
 *   wa.on('statusUploadError', (err) => {}) → Error al subir estado
 *   wa.on('statusScheduled', ({ id, cronExpression }) => {})
 *   wa.on('statusScheduleCancelled', (id) => {})
 *   wa.on('loggedOut', () => {})           → Sesión cerrada
 *
 * ============================================================
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import cron from 'node-cron'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import pino from 'pino'

/**
 * Logger silencioso compatible con Baileys.
 *
 * IMPORTANTE: Baileys requiere una instancia real de pino porque internamente
 * llama a logger.child({}) para crear sub-loggers por módulo. Si pasas
 * undefined o un objeto simple sin el método .child(), el proceso crasheará.
 *
 * level: 'silent' → Suprime todos los logs internos de Baileys (recomendado
 * para producción). En desarrollo puedes cambiar a 'warn' o 'debug' para ver
 * qué está haciendo Baileys internamente.
 */
const baileysLogger = pino({ level: 'silent' })

// ─── Tipos exportados ─────────────────────────────────────────────────────────

export type StatusMediaType = 'image' | 'video' | 'text'

export interface StatusUploadOptions {
  /** Tipo de estado: texto, imagen o video */
  type: StatusMediaType
  /**
   * Ruta absoluta al archivo para estados de imagen o video.
   * Ejemplo: '/home/user/photos/foto.jpg'
   */
  filePath?: string
  /**
   * Texto del estado (para type='text') o caption (para imagen/video).
   * En WhatsApp el caption aparece debajo de la imagen/video.
   */
  caption?: string
  /**
   * Color de fondo para estados de TEXTO (hex string, incluir el '#').
   * Ejemplo: '#25D366' (verde WhatsApp), '#FF0000' (rojo), '#000000' (negro)
   * Solo aplica para type='text'. Baileys lo convierte internamente a ARGB.
   */
  backgroundColor?: string
  /**
   * Fuente para estados de texto (número entre 0 y 8).
   * 0=SANS_SERIF, 1=SERIF, 2=NORICAN, 3=BRYNDAN_WRITE, 4=BEBASNEUE, 5=OSWALD
   * Solo aplica para type='text'.
   */
  font?: number
}

export interface ScheduledStatus {
  id: string
  cronExpression: string
  options: StatusUploadOptions
  task?: cron.ScheduledTask
}

export interface WhatsAppConnectorOptions {
  /**
   * Número de teléfono CON código de país, sin '+' ni espacios ni guiones.
   * Ejemplos:
   *   México: '521234567890'  (52 = código de país)
   *   España: '34612345678'   (34 = código de país)
   *   Cuba:   '5351234567'    (53 = código de país)
   */
  phoneNumber: string
  /**
   * Directorio donde se guardan los archivos de sesión.
   * Por defecto: './wa-session' (relativo al process.cwd())
   *
   * IMPORTANTE: No borres este directorio mientras WhatsApp está conectado.
   * Si lo borras, tendrás que vincular de nuevo con un nuevo código.
   * Haz backup de este directorio si quieres persistir la sesión.
   */
  sessionDir?: string
  /**
   * Logger personalizado para los mensajes del conector (no de Baileys).
   * Si no lo provees, usa console.log/error/warn.
   */
  logger?: {
    info: (msg: string) => void
    error: (msg: string, err?: unknown) => void
    warn: (msg: string) => void
  }
}

// ─── Clase principal ──────────────────────────────────────────────────────────

export class WhatsAppConnector extends EventEmitter {
  private sock: WASocket | null = null
  private options: Required<WhatsAppConnectorOptions>
  /** Caché para reintentos de mensajes (requerido por Baileys) */
  private msgRetryCounterCache = new NodeCache()
  private scheduledStatuses: Map<string, ScheduledStatus> = new Map()
  private isConnected = false
  private isConnecting = false
  private pairingCodeRequested = false
  private contactSyncTimer: NodeJS.Timeout | null = null
  private sessionWatcher: fs.FSWatcher | null = null

  /**
   * Mapa de contactos capturados del evento contacts.upsert.
   *
   * POR QUÉ ESTO ES NECESARIO:
   * Baileys requiere que pases la lista de JIDs de tus contactos en el
   * parámetro statusJidList al enviar un estado. Sin esto, el estado
   * se "envía" sin error pero nadie lo recibe (ni aparece en tu propia app).
   *
   * WhatsApp sincroniza los contactos automáticamente al conectarse.
   * Los capturamos con el evento 'contacts.upsert' y los almacenamos aquí.
   *
   * Formato de las keys: JID en formato @s.whatsapp.net
   * Ejemplo: '521234567890@s.whatsapp.net'
   */
  private contactsCache: Set<string> = new Set()

  constructor(options: WhatsAppConnectorOptions) {
    super()
    this.options = {
      phoneNumber: options.phoneNumber,
      sessionDir: options.sessionDir ?? path.join(process.cwd(), 'wa-session'),
      logger: options.logger ?? {
        info: (msg: string) => console.log(`[WA INFO] ${msg}`),
        error: (msg: string, err?: unknown) => console.error(`[WA ERROR] ${msg}`, err ?? ''),
        warn: (msg: string) => console.warn(`[WA WARN] ${msg}`),
      },
    }
  }

  // ─── Estado de la conexión ────────────────────────────────────────────────

  /** true si WhatsApp está conectado y listo */
  get connected(): boolean { return this.isConnected }

  /** true si está intentando conectarse */
  get connecting(): boolean { return this.isConnecting }

  // ─── Hidratación continua de contactos ────────────────────────────────────

  private startContactHydration(): void {
    this.stopContactHydration()

    this.loadContactsFromSession()

    try {
      this.sessionWatcher = fs.watch(this.options.sessionDir, { persistent: false }, (_, filename) => {
        if (!filename) return

        if (
          filename.startsWith('lid-mapping-') &&
          filename.endsWith('.json')
        ) {
          this.loadContactsFromSession()
        }
      })
    } catch (err) {
      this.options.logger.warn(`Watcher error: ${err}`)
    }

    this.contactSyncTimer = setInterval(() => {
      if (this.isConnected) {
        this.loadContactsFromSession()
      }
    }, 10000)
  }

  private stopContactHydration(): void {
    if (this.contactSyncTimer) {
      clearInterval(this.contactSyncTimer)
      this.contactSyncTimer = null
    }

    if (this.sessionWatcher) {
      this.sessionWatcher.close()
      this.sessionWatcher = null
    }
  }

  // ─── Solicitar código de emparejamiento ───────────────────────────────────

  /**
   * Solicita el código de emparejamiento de 8 dígitos.
   *
   * FLUJO COMPLETO:
   * 1. Llamas a este método con el número de teléfono
   * 2. WhatsApp envía una NOTIFICACIÓN al teléfono del usuario:
   *    "Alguien intenta vincular tu cuenta a un nuevo dispositivo"
   * 3. El usuario debe APROBAR en el teléfono:
   *    Ajustes → Dispositivos vinculados → Vincular dispositivo
   * 4. WhatsApp genera el código de 8 dígitos y lo devuelve aquí
   * 5. El usuario ingresa ese código en el campo correspondiente
   *
   * DIFERENCIA CON EL FLUJO DE QR:
   * En QR, el usuario escanea. En código de emparejamiento, el usuario
   * escribe el código manualmente. Ambos usan el mismo protocolo por debajo.
   *
   * @returns string con el código formateado, ej: 'ABCD-1234'
   */
  async requestPairingCode(): Promise<string> {
    if (this.isConnected) {
      throw new Error('WhatsApp ya está conectado. Desconecta primero.')
    }
    if (this.isConnecting && this.pairingCodeRequested) {
      throw new Error('Ya se solicitó un código. Espera la respuesta.')
    }

    this.options.logger.info(`Iniciando vinculación por código para: ${this.options.phoneNumber}`)

    // Crea el directorio de sesión si no existe
    if (!fs.existsSync(this.options.sessionDir)) {
      fs.mkdirSync(this.options.sessionDir, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.options.sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    this.options.logger.info(`Baileys versión: ${version.join('.')}`)

    /**
     * Creación del socket de WhatsApp.
     *
     * Opciones importantes:
     * - logger: DEBE ser una instancia de pino (ver nota arriba)
     * - printQRInTerminal: false → No queremos QR, solo código de emparejamiento
     * - makeCacheableSignalKeyStore: Optimiza el acceso a las claves de cifrado.
     *   También requiere una instancia de pino.
     * - msgRetryCounterCache: Para reintentos automáticos de mensajes fallidos
     * - generateHighQualityLinkPreview: Genera preview de links en mensajes
     */
    this.sock = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      mobile: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      msgRetryCounterCache: this.msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      defaultQueryTimeoutMs: undefined,
    })

    this.isConnecting = true

    // Persiste las credenciales cada vez que cambien
    this.sock.ev.on('creds.update', saveCreds)

    /**
     * contacts.upsert — Actualización incremental de contactos nuevos
     *
     * En Baileys v7 con LID, este evento ya NO trae la lista completa de
     * contactos al conectarse — los contactos se sincronizan via app-state y
     * se escriben como archivos lid-mapping-*.json. Este listener sirve para
     * capturar contactos individuales nuevos (ej: alguien te escribe por
     * primera vez) y para re-escanear el directorio cuando Baileys escribe
     * nuevos archivos de mapeo.
     */
    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        const id = contact.id?.trim()
        if (id && id.endsWith('@s.whatsapp.net')) {
          this.contactsCache.add(id)
        }

        const phone = contact.phoneNumber?.trim()
        if (phone && /^\d+$/.test(phone)) {
          this.contactsCache.add(`${phone}@s.whatsapp.net`)
        }
      }

      this.loadContactsFromSession()
    })

    // Maneja cambios en el estado de la conexión
    this.sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        // Ignoramos el QR — estamos en modo código de emparejamiento
        this.options.logger.warn('Se generó QR pero usamos código. Ignorando.')
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        // loggedOut (401) = el usuario cerró sesión en el teléfono → no reconectar
        // Cualquier otro código → intentar reconectar
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        this.stopContactHydration()
        this.isConnected = false
        this.isConnecting = false

        this.options.logger.warn(`Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`)
        this.emit('disconnected', { statusCode, shouldReconnect })

        if (shouldReconnect) {
          this.options.logger.info('Reconectando en 5s...')
          setTimeout(() => this.reconnect(), 5000)
        } else {
          // Limpia la sesión si fue logout explícito
          this.clearSession()
        }
      } else if (connection === 'open') {
        this.isConnected = true
        this.isConnecting = false
        this.pairingCodeRequested = false
        this.options.logger.info('✅ WhatsApp conectado')
        // Carga los contactos de los archivos de sesión inmediatamente
        this.startContactHydration()
        this.emit('connected')
      } else if (connection === 'connecting') {
        this.emit('connecting')
      }
    })

    // Solicita el código de emparejamiento
    // Esperamos 3 segundos para que el socket se inicialice antes de pedirlo
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          if (!this.sock) { reject(new Error('Socket no inicializado')); return }

          if (!this.sock.authState.creds.registered) {
            // La cuenta aún no está registrada → solicitar código
            this.pairingCodeRequested = true
            this.options.logger.info('Solicitando código de emparejamiento...')

            const code = await this.sock.requestPairingCode(this.options.phoneNumber)
            // Baileys devuelve 8 chars sin separador, los formateamos como XXXX-XXXX
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') ?? code

            this.options.logger.info(`Código: ${formattedCode}`)
            this.emit('pairingCode', formattedCode)
            resolve(formattedCode)
          } else {
            // Ya existe una sesión activa, no necesitamos código
            this.options.logger.info('Sesión activa existente, no se necesita código')
            this.emit('alreadyRegistered')
            resolve('SESIÓN_ACTIVA')
          }
        } catch (err) {
          this.options.logger.error('Error al solicitar código', err)
          reject(err)
        }
      }, 3000)
    })
  }

  // ─── Reconexión automática ────────────────────────────────────────────────

  /**
   * Reconecta usando la sesión guardada (sin pedir nuevo código).
   * Se llama automáticamente cuando la conexión se cierra por error.
   */
  private async reconnect(): Promise<void> {
    if (this.isConnected || this.isConnecting) return

    this.options.logger.info('Reconectando...')
    this.isConnecting = true

    const { state, saveCreds } = await useMultiFileAuthState(this.options.sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    this.sock = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      msgRetryCounterCache: this.msgRetryCounterCache,
    })

    this.sock.ev.on('creds.update', saveCreds)

    // Mismo listener para reconexiones — actualiza con nuevos contactos
    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        const id = contact.id?.trim()
        if (id && id.endsWith('@s.whatsapp.net')) {
          this.contactsCache.add(id)
        }

        const phone = contact.phoneNumber?.trim()
        if (phone && /^\d+$/.test(phone)) {
          this.contactsCache.add(`${phone}@s.whatsapp.net`)
        }
      }
      this.loadContactsFromSession()
    })

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
        this.stopContactHydration()
        this.isConnected = false
        this.isConnecting = false

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => this.reconnect(), 5000)
        } else {
          this.clearSession()
        }
      } else if (connection === 'open') {
        this.isConnected = true
        this.isConnecting = false
        this.startContactHydration()
        this.emit('connected')
      }
    })
  }

  // ─── Gestión de contactos para status broadcast ───────────────────────────

  /**
   * Devuelve el número de contactos en caché.
   */
  get contactsCount(): number { return this.contactsCache.size }

  /**
   * Carga contactos desde los archivos de sesión guardados por Baileys.
   *
   * POR QUÉ ESTE ENFOQUE EN LUGAR DE contacts.upsert:
   * Baileys v7 usa el sistema LID (Linked Identity) de WhatsApp. Los contactos
   * se sincronizan via app-state y se guardan como archivos `lid-mapping-*.json`
   * en el directorio de sesión. El evento contacts.upsert ya no se emite de
   * forma confiable en v7 para la lista completa de contactos.
   *
   * FORMATO DE LOS ARCHIVOS:
   *   lid-mapping-PHONENUMBER.json         → mapea teléfono → LID
   *   lid-mapping-LIDNUMBER_reverse.json   → mapea LID → teléfono
   *
   * Usamos los archivos SIN "_reverse" porque el nombre del archivo ES el
   * número de teléfono del contacto (solo dígitos).
   *
   * Resultado: JIDs en formato PHONE@s.whatsapp.net, que es el formato
   * correcto para statusJidList.
   */
  private loadContactsFromSession(): void {
    try {
      const before = this.contactsCache.size
      const files = fs.readdirSync(this.options.sessionDir)
      let added = 0

      for (const file of files) {
        if (!file.startsWith('lid-mapping-') || !file.endsWith('.json')) continue

        const phoneFromName = file.replace('lid-mapping-', '').replace('.json', '')
        if (/^\d+$/.test(phoneFromName)) {
          this.contactsCache.add(`${phoneFromName}@s.whatsapp.net`)
          added++
        }

        try {
          const raw = fs.readFileSync(path.join(this.options.sessionDir, file), 'utf8').trim()
          if (raw) {
            const value = JSON.parse(raw)
            if (typeof value === 'string') {
              const cleaned = value.trim()
              if (/^\d+$/.test(cleaned)) {
                this.contactsCache.add(`${cleaned}@s.whatsapp.net`)
                added++
              } else if (cleaned.endsWith('@s.whatsapp.net')) {
                this.contactsCache.add(cleaned)
                added++
              }
            }
          }
        } catch {
          // Ignorar archivos individuales malformados; seguimos con el resto
        }
      }

      if (this.contactsCache.size !== before) {
        this.emit('contactsUpdated', { count: this.contactsCache.size })
      }

      this.options.logger.info(`Contactos en caché: ${this.contactsCache.size} (+${this.contactsCache.size - before}) | Archivos leídos: ${added}`)
    } catch (err) {
      this.options.logger.warn(`No se pudo leer contactos de sesión: ${err}`)
    }
  }

  /**
   * Obtiene la lista de JIDs para statusJidList al enviar estados.
   *
   * Si el caché está vacío (primera vez, sin sesión previa), devuelve []
   * y muestra advertencia — el estado no llegará a nadie en ese caso.
   * Después de la primera conexión exitosa, los contactos se cargan
   * automáticamente desde los archivos de sesión.
   */
  private getStatusJidList(): string[] {
    const list = Array.from(this.contactsCache)
    if (list.length === 0) {
      this.options.logger.warn(
        'ADVERTENCIA: Sin contactos en caché. El estado no llegará a nadie. ' +
        'Asegúrate de que la sesión esté completa y vuelve a intentarlo.'
      )
    } else {
      this.options.logger.info(`Enviando estado a ${list.length} contactos`)
    }
    return list
  }

  // ─── Subir al Estado de WhatsApp ─────────────────────────────────────────

  /**
   * Sube contenido al Estado de WhatsApp (Stories).
   *
   * TIPOS DE ESTADO:
   *
   *   type='text'  → Estado de texto con color de fondo
   *     { type: 'text', caption: 'Hola!', backgroundColor: '#25D366', font: 0 }
   *
   *   type='image' → Estado de imagen con caption opcional
   *     { type: 'image', filePath: '/ruta/imagen.jpg', caption: 'Mi foto' }
   *
   *   type='video' → Estado de video con caption opcional
   *     { type: 'video', filePath: '/ruta/video.mp4', caption: 'Mi video' }
   *
   * IMPORTANTE: WhatsApp tiene límites:
   * - Imágenes: máximo 16 MB en la práctica (recomendado < 1 MB para velocidad)
   * - Videos: máximo 16 MB y máximo 30 segundos
   * - Texto: máximo 700 caracteres
   */
  async uploadStatus(options: StatusUploadOptions): Promise<void> {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp no está conectado. Vincula el dispositivo primero.')
    }

    this.options.logger.info(`Subiendo estado: tipo=${options.type}`)

    try {
      if (options.type === 'text') {
        await this.uploadTextStatus(options)
      } else if (options.type === 'image') {
        await this.uploadImageStatus(options)
      } else if (options.type === 'video') {
        await this.uploadVideoStatus(options)
      }

      this.options.logger.info('✅ Estado subido exitosamente')
      this.emit('statusUploaded', options)
    } catch (err) {
      this.options.logger.error('Error al subir estado', err)
      this.emit('statusUploadError', err)
      throw err
    }
  }

  /**
   * Estado de texto.
   *
   * CLAVE TÉCNICA: El color de fondo y la fuente van en el TERCER parámetro
   * de sendMessage (las "options"), NO dentro del contenido del mensaje.
   * Baileys internamente convierte el hex string a ARGB para el protocolo.
   *
   * Destino 'status@broadcast' es el JID especial de WhatsApp para Stories.
   */
  private async uploadTextStatus(options: StatusUploadOptions): Promise<void> {
    if (!this.sock) throw new Error('Socket no disponible')

    await this.sock.sendMessage(
      'status@broadcast',
      { text: options.caption ?? '' },
      {
        backgroundColor: options.backgroundColor ?? '#25D366',
        font: options.font ?? 0,
        statusJidList: this.getStatusJidList(),
      }
    )
  }

  /**
   * Estado de imagen.
   *
   * Lee el archivo del disco y lo manda como buffer.
   * También puedes usar { url: 'https://...' } en lugar de un buffer
   * si la imagen está en internet.
   */
  private async uploadImageStatus(options: StatusUploadOptions): Promise<void> {
    if (!this.sock) throw new Error('Socket no disponible')
    if (!options.filePath) throw new Error('Se requiere filePath para estados de imagen')
    if (!fs.existsSync(options.filePath)) throw new Error(`Archivo no encontrado: ${options.filePath}`)

    const imageBuffer = fs.readFileSync(options.filePath)

    await this.sock.sendMessage(
      'status@broadcast',
      {
        image: imageBuffer,
        caption: options.caption ?? '',
      },
      { statusJidList: this.getStatusJidList() }
    )
  }

  /**
   * Estado de video.
   *
   * Límites de WhatsApp: máximo ~16 MB y 30 segundos de duración.
   * Formatos soportados: mp4, 3gpp.
   */
  private async uploadVideoStatus(options: StatusUploadOptions): Promise<void> {
    if (!this.sock) throw new Error('Socket no disponible')
    if (!options.filePath) throw new Error('Se requiere filePath para estados de video')
    if (!fs.existsSync(options.filePath)) throw new Error(`Archivo no encontrado: ${options.filePath}`)

    const videoBuffer = fs.readFileSync(options.filePath)

    await this.sock.sendMessage(
      'status@broadcast',
      {
        video: videoBuffer,
        caption: options.caption ?? '',
      },
      { statusJidList: this.getStatusJidList() }
    )
  }

  // ─── Programación automática de estados ───────────────────────────────────

  /**
   * Programa una subida automática al Estado con expresión cron.
   *
   * EXPRESIONES CRON (formato: minuto hora día-mes mes día-semana):
   *   '0 9 * * *'        → Todos los días a las 9:00 AM
   *   '0 9,21 * * *'     → Dos veces al día: 9 AM y 9 PM
   *   '0 * * * *'        → Cada hora en punto
   *   '30 8 * * 1-5'     → Lunes a viernes a las 8:30 AM
   *   '0 12 1 * *'       → El día 1 de cada mes a las 12:00 PM
   *   '* /30 * * * *'    → Cada 30 minutos
   *
   * La tarea se ejecuta automáticamente según el cron y llama a uploadStatus().
   * Si WhatsApp no está conectado en ese momento, lanzará error (que se captura).
   *
   * @returns ID único de la tarea programada (para poder cancelarla después)
   */
  scheduleStatus(cronExpression: string, uploadOptions: StatusUploadOptions): string {
    const id = `status_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    const task = cron.schedule(cronExpression, async () => {
      this.options.logger.info(`Ejecutando estado programado: ${id}`)
      try {
        await this.uploadStatus(uploadOptions)
      } catch (err) {
        this.options.logger.error(`Error en estado programado ${id}`, err)
      }
    })

    this.scheduledStatuses.set(id, { id, cronExpression, options: uploadOptions, task })
    task.start()

    this.options.logger.info(`Programado ${id} | Cron: ${cronExpression}`)
    this.emit('statusScheduled', { id, cronExpression })
    return id
  }

  /**
   * Cancela y elimina una tarea programada por su ID.
   * @returns true si se canceló, false si el ID no existía
   */
  cancelScheduledStatus(id: string): boolean {
    const scheduled = this.scheduledStatuses.get(id)
    if (!scheduled) return false

    scheduled.task?.stop()
    this.scheduledStatuses.delete(id)
    this.options.logger.info(`Tarea cancelada: ${id}`)
    this.emit('statusScheduleCancelled', id)
    return true
  }

  /**
   * Lista todas las tareas programadas activas.
   * Útil para mostrarlas en una UI o para auditoría.
   */
  listScheduledStatuses(): Array<Omit<ScheduledStatus, 'task'>> {
    return Array.from(this.scheduledStatuses.values()).map(({ id, cronExpression, options }) => ({
      id,
      cronExpression,
      options,
    }))
  }

  // ─── Desconexión y limpieza ───────────────────────────────────────────────

  /**
   * Cierra sesión completamente.
   *
   * Esto hace logout en el servidor de WhatsApp Y elimina los archivos de sesión.
   * Después de esto necesitarás vincular de nuevo con un nuevo código.
   *
   * Úsalo cuando el usuario quiera desvincular el bot permanentemente.
   */
  async logout(): Promise<void> {
    this.stopContactHydration()

    if (this.sock) {
      await this.sock.logout()
      this.sock = null
    }
    this.isConnected = false
    this.isConnecting = false
    this.clearSession()
    this.options.logger.info('Sesión cerrada')
    this.emit('loggedOut')
  }

  /**
   * Desconecta el socket sin cerrar sesión.
   *
   * La sesión queda guardada en disco. Al llamar requestPairingCode() o
   * reconnect() de nuevo, se reconecta sin pedir código.
   * Útil para reiniciar el servidor o hacer mantenimiento.
   */
  async disconnect(): Promise<void> {
    this.stopContactHydration()

    if (this.sock) {
      this.sock.end(undefined)
      this.sock = null
    }
    this.isConnected = false
    this.isConnecting = false
    this.options.logger.info('Desconectado (sesión conservada)')
  }

  /** Elimina los archivos de sesión del disco */
  private clearSession(): void {
    if (fs.existsSync(this.options.sessionDir)) {
      fs.rmSync(this.options.sessionDir, { recursive: true, force: true })
      this.options.logger.info(`Sesión eliminada: ${this.options.sessionDir}`)
    }
  }
}

export default WhatsAppConnector
