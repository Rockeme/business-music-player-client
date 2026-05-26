# Rockplayer — Cliente de música para negocios

> Aplicación de escritorio que conecta tu negocio al servicio de música Rockeme, con reproducción continua incluso sin internet.

---

## Tabla de contenido

1. [¿Qué es Rockplayer?](#qué-es-rockplayer)
2. [Requisitos del sistema](#requisitos-del-sistema)
3. [Instalación](#instalación)
4. [Primer uso — Configuración del servicio](#primer-uso--configuración-del-servicio)
5. [Funcionalidades](#funcionalidades)
6. [Menú de la aplicación](#menú-de-la-aplicación)
7. [Preguntas frecuentes](#preguntas-frecuentes)
8. [Soporte](#soporte)

---

## ¿Qué es Rockplayer?

Rockplayer es el cliente de escritorio oficial del servicio **Business Music Player** de [Rockeme S.A.S.](https://rockeme.com). Funciona como una ventana dedicada al reproductor de música de tu negocio: se conecta al servidor configurado, reproduce la música de forma continua y, si la conexión se interrumpe, **cambia automáticamente a reproducción sin conexión** con las canciones que ya descargó en segundo plano.

No es necesario abrir un navegador ni configurar nada manualmente cada vez que inicias el equipo. Rockplayer arranca, se conecta y empieza a sonar.

---

## Requisitos del sistema

| Componente | Mínimo recomendado |
|---|---|
| Sistema operativo | Windows 10 o superior (64 bits) |
| RAM | 512 MB disponibles |
| Espacio en disco | 200 MB para la aplicación + hasta 500 MB para caché de audio |
| Red | Conexión a la misma red donde está el servidor del servicio |

---

## Instalación

### Instalación para usuarios finales (recomendado)

1. Descarga el instalador `RockplayerSetup.exe` desde la sección [**Releases**](https://github.com/Rockeme/business-music-player-client/releases) del repositorio.
2. Ejecuta el instalador. Windows puede mostrar un aviso de seguridad — haz clic en **"Ejecutar de todas formas"** para continuar.
3. La instalación es silenciosa y tarda unos segundos. Al finalizar, Rockplayer se abrirá automáticamente.
4. No es necesario reiniciar el equipo.

> **Nota:** El instalador coloca un acceso directo en el escritorio y opcionalmente puede configurarse para **iniciar con Windows** (ver sección [Menú de la aplicación](#menú-de-la-aplicación)).

### Desinstalación

Dirígete a **Configuración de Windows → Aplicaciones** (o Panel de control → Programas), busca **Rockplayer** y selecciona *Desinstalar*. Todos los archivos del programa se eliminan automáticamente. Los archivos de configuración y caché de audio se almacenan en `%APPDATA%\Rockplayer` y pueden borrarse manualmente si lo deseas.

---

## Primer uso — Configuración del servicio

La primera vez que abras Rockplayer verás la pantalla de configuración:

```
┌─────────────────────────────────┐
│   Configuración del servicio    │
│                                 │
│  URL del servicio               │
│  [ http://192.168.1.10/... ]   │
│                                 │
│         [ Conectar ]            │
└─────────────────────────────────┘
```

1. **Ingresa la URL base** del servidor al que te proporcionó tu administrador de sistema o el proveedor del servicio. Ejemplos válidos:
   - `http://192.168.1.10/business-music-player`
   - `https://musica.minegocio.com`
2. Haz clic en **Conectar**.
3. Rockplayer validará la URL, guardará la configuración y te llevará directamente a la pantalla de inicio de sesión del servicio.

A partir de ese momento, la URL queda guardada. En los siguientes arranques la aplicación se conectará automáticamente, sin mostrar esta pantalla de nuevo.

Si necesitas cambiar el servidor, ve al menú **Servicio → Reconfigurar servicio**.

---

## Funcionalidades

### 🎵 Reproducción en línea
Rockplayer carga directamente la interfaz del servicio de música en una ventana dedicada. Toda la navegación, listas de reproducción y controles del servicio funcionan igual que en un navegador, pero sin distracciones y sin que el usuario pueda cerrar la pestaña accidentalmente.

---

### 📥 Caché de audio automático
Mientras el servicio está en línea, Rockplayer **descarga en segundo plano** cada canción que se reproduce. Esto ocurre de forma completamente transparente, sin interrumpir la reproducción ni requerir ninguna acción del usuario.

- Se guardan hasta **500 MB** de audio en el equipo local.
- Se admiten los formatos: MP3, OGG, WAV, FLAC, AAC, M4A, OPUS y WebM.
- Los metadatos (título, artista, álbum, año) y la **carátula del álbum** se extraen y almacenan automáticamente.
- Cuando el caché está lleno, se eliminan automáticamente las canciones más antiguas para dejar espacio a las nuevas.

---

### 📡 Reproducción sin conexión automática
Si la conexión al servidor se interrumpe (corte de internet, fallo del servidor, etc.), Rockplayer detecta el problema en segundos y:

1. Cambia a modo **Sin conexión**, mostrando el reproductor local.
2. Reproduce las canciones descargadas en caché en orden, con controles completos.
3. Sigue verificando la conectividad cada **15 segundos**.

Cuando el servicio vuelve a estar disponible, Rockplayer te notifica y espera a que termine la canción actual antes de volver al modo en línea — sin cortes abruptos.

---

### 🔄 Reconexión automática y suave
La transición de vuelta al modo en línea es silenciosa y sin interrupciones:
- Un indicador de estado aparece brevemente con el texto **"Reconectando…"**.
- Al terminar la canción actual, la aplicación navega sola al servicio y reanuda la reproducción automáticamente.
- También puedes volver en cualquier momento usando el botón **"Volver ahora"** que aparece en el reproductor sin conexión.

---

### 🟢 Indicador de estado de conexión
En la esquina inferior derecha de la pantalla siempre hay una pequeña etiqueta que muestra el estado actual de la conexión:

| Color | Estado |
|---|---|
| 🟢 Verde | En línea — el servicio es accesible |
| 🔴 Rojo | Sin conexión — reproduciendo desde caché |
| 🟡 Amarillo | Conexión inestable — el servicio podría fallar pronto |
| 🟠 Naranja | Reconectando — el servicio volvió, esperando fin de canción |

---

### ⌨️ Teclas multimedia del teclado
Rockplayer responde a las teclas multimedia del teclado **de forma global**, incluso si la ventana no tiene el foco:

| Tecla | Acción |
|---|---|
| ▶⏸ Play/Pausa | Reproducir o pausar |
| ⏭ Siguiente | Siguiente pista |
| ⏮ Anterior | Pista anterior |
| ⏹ Detener | Detener reproducción |

Esto permite controlar la música desde un teclado multimedia sin necesidad de hacer clic en la ventana.

---

### 🗂️ Minimizar a la bandeja del sistema
Al cerrar la ventana (haciendo clic en la X), Rockplayer **no se cierra**: se minimiza a la bandeja del sistema (junto al reloj de Windows). La música sigue sonando en segundo plano.

Para mostrar la ventana nuevamente, haz clic en el ícono de Rockplayer en la bandeja. Para cerrar la aplicación completamente, usa el menú de la bandeja o **Servicio → Salir**.

---

### 🔁 Actualizaciones automáticas
Rockplayer se actualiza solo. Al arrancar, verifica si hay una nueva versión disponible y, si la hay, la descarga silenciosamente en segundo plano. Cuando la descarga termina, aparece un cuadro de diálogo que te pregunta si deseas reiniciar ahora o más tarde para aplicar la actualización.

También puedes verificar manualmente desde **Servicio → Buscar actualizaciones…**

---

### 🚀 Inicio con Windows
Puedes configurar Rockplayer para que se inicie automáticamente cuando enciendas el equipo, sin necesidad de abrirlo manualmente. Activa o desactiva esta opción desde **Servicio → Iniciar con Windows**.

---

### 🔒 Instancia única
Rockplayer garantiza que solo se ejecute **una instancia a la vez**. Si intentas abrir la aplicación cuando ya está corriendo en la bandeja, simplemente trae la ventana existente al frente.

---

## Menú de la aplicación

El menú **Servicio** (barra de menú superior) reúne todas las opciones de configuración y mantenimiento:

| Opción | Descripción |
|---|---|
| **Reconfigurar servicio** | Vuelve a la pantalla de configuración para cambiar la URL del servidor |
| **Borrar canciones en caché** | Elimina todos los archivos de audio guardados localmente |
| **Buscar actualizaciones…** | Verifica manualmente si hay una nueva versión disponible |
| **Acerca de Rockplayer** | Muestra la versión instalada e información del desarrollador |
| **Iniciar con Windows** | Activa o desactiva el inicio automático con el sistema operativo |
| **Salir** | Cierra Rockplayer completamente |

---

## Preguntas frecuentes

**¿Qué pasa si no tengo canciones en caché y se va la conexión?**  
El reproductor sin conexión aparecerá, pero la lista de canciones estará vacía. Rockplayer esperará a que el servicio vuelva y volverá automáticamente al modo en línea.

**¿Puedo usar Rockplayer en Mac o Linux?**  
La versión actual está optimizada para Windows. El código fuente soporta otras plataformas, pero los instaladores distribuidos oficialmente son solo para Windows.

**¿La caché de audio consume mucho espacio?**  
El caché tiene un límite de 500 MB. Cuando se llena, las canciones más antiguas se eliminan automáticamente para dejar espacio a las nuevas. Puedes borrar el caché en cualquier momento desde **Servicio → Borrar canciones en caché**.

**¿Cómo sé qué versión tengo instalada?**  
Ve a **Servicio → Acerca de Rockplayer**. Verás el número de versión actual.

**La ventana desapareció, ¿cómo la recupero?**  
Busca el ícono de Rockplayer en la bandeja del sistema (junto al reloj de Windows) y haz clic en él para mostrar la ventana.

---

## Soporte

- 🐛 **Reportar un problema:** [GitHub Issues](https://github.com/Rockeme/business-music-player-client/issues)
- 🌐 **Sitio web:** [rockeme.com](https://rockeme.com)

---

<p align="center">
  © 2026 <a href="https://rockeme.com">Rockeme S.A.S.</a> — Todos los derechos reservados.
</p>
