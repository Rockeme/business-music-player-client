'use strict'
/* global window, document */

let songs = []
let currentIndex = -1
let pendingResume = false   // true when connectivity restored, waiting for song end

const player = document.getElementById('player')
const songTitle = document.getElementById('song-title')
const songList = document.getElementById('song-list')
const emptyMsg = document.getElementById('empty-msg')
const btnPrev = document.getElementById('btn-prev')
const btnNext = document.getElementById('btn-next')
const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const reconnectBanner = document.getElementById('reconnect-banner')
const reconnectMsg = document.getElementById('reconnect-msg')
const btnResumeOnline = document.getElementById('btn-resume-online')

// ── Helpers ──────────────────────────────────────────────────────────────────

function fileUrl(filePath) {
    // Convert an absolute OS path to a proper file:// URL
    return 'file:///' + filePath.replace(/\\/g, '/')
}

function renderList() {
    // Remove existing song items (keep #empty-msg)
    songList.querySelectorAll('.song-item').forEach(el => el.remove())

    if (songs.length === 0) {
        emptyMsg.style.display = 'block'
        return
    }
    emptyMsg.style.display = 'none'

    songs.forEach((song, i) => {
        const item = document.createElement('div')
        item.className = 'song-item' + (i === currentIndex ? ' active' : '')
        item.dataset.index = i

        const num = document.createElement('div')
        num.className = 'song-num'
        num.textContent = i + 1

        const name = document.createElement('div')
        name.className = 'song-name'
        name.textContent = song.title || `Canción ${i + 1}`

        item.appendChild(num)
        item.appendChild(name)
        item.addEventListener('click', () => playSong(i))
        songList.appendChild(item)
    })
}

function updateActiveItem() {
    songList.querySelectorAll('.song-item').forEach((el, i) => {
        el.classList.toggle('active', i === currentIndex)
    })
}

function playSong(index) {
    if (index < 0 || index >= songs.length) return
    currentIndex = index
    const song = songs[index]

    player.src = fileUrl(song.filePath)
    songTitle.textContent = song.title || `Canción ${index + 1}`
    player.play().catch(() => { /* user gesture may be required */ })

    btnPrev.disabled = currentIndex <= 0
    btnNext.disabled = currentIndex >= songs.length - 1
    updateActiveItem()
}

// ── Auto-advance on track end ─────────────────────────────────────────────────
player.addEventListener('ended', () => {
    if (pendingResume) {
        // Connectivity was restored — this is the right moment to switch online
        window.versions.resumeOnlineService()
        return
    }
    if (currentIndex < songs.length - 1) {
        playSong(currentIndex + 1)
    }
})

// ── Controls ─────────────────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => playSong(currentIndex - 1))
btnNext.addEventListener('click', () => playSong(currentIndex + 1))

// ── Load cached songs on startup ─────────────────────────────────────────────
window.versions.getCachedSongs().then((cachedSongs) => {
    songs = cachedSongs || []
    renderList()
    if (songs.length > 0) {
        playSong(0)
        btnPrev.disabled = true
        btnNext.disabled = songs.length <= 1
    }
}).catch(() => {
    emptyMsg.style.display = 'block'
    emptyMsg.textContent = 'Error al leer canciones guardadas.'
})

// ── Connectivity status polling ───────────────────────────────────────────────
function pollStatus() {
    window.versions.getOfflineStatus().then(({ isOnline }) => {
        if (isOnline && !pendingResume) {
            // Connectivity restored but we haven't received the IPC push yet
            statusDot.style.background = '#66bb6a'
            statusDot.className = 'checking'
            statusText.textContent = 'Conexión restaurada'
        } else if (!pendingResume) {
            statusDot.style.background = '#ef5350'
            statusDot.className = ''
            statusText.textContent = 'Sin conexión — reproduciendo desde caché local'
        }
    }).catch(() => {})
}

setInterval(pollStatus, 5000)
pollStatus()

// ── Deferred online resume ────────────────────────────────────────────────────
// Main process pushes this event when connectivity is restored while offline.
window.versions.onConnectivityRestored(() => {
    if (pendingResume) return   // already handling it
    pendingResume = true

    // Update status bar
    statusDot.style.background = '#66bb6a'
    statusDot.className = 'checking'
    statusText.textContent = 'Conexión restaurada — volviendo al terminar esta canción'

    // Show reconnect banner
    reconnectBanner.classList.add('visible')

    // If nothing is playing right now, switch immediately
    if (player.paused || player.ended || player.src === '') {
        window.versions.resumeOnlineService()
    }
})

// "Volver ahora" button — let the user skip the wait
btnResumeOnline.addEventListener('click', () => {
    pendingResume = false
    reconnectBanner.classList.remove('visible')
    window.versions.resumeOnlineService()
})
