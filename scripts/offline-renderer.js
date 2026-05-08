'use strict'
/* global window, document */

// ── State ─────────────────────────────────────────────────────────────────────
let songs = []
let currentIndex = -1
let isStopped = true
let isMuted = false
let pendingResume = false   // true when connectivity restored, waiting for song end

// ── Element references ────────────────────────────────────────────────────────
const player      = document.getElementById('player')
const songTitle   = document.getElementById('current-song-title')
const songArtist  = document.getElementById('current-song-artist')
const songAlbum   = document.getElementById('current-song-album')
const songCover   = document.getElementById('current-song-cover')
const songList    = document.getElementById('song-list')
const emptyMsg    = document.getElementById('empty-msg')
const playButton  = document.getElementById('play-button')
const pauseButton = document.getElementById('pause-button')
const stopButton  = document.getElementById('stop-button')
const btnPrev     = document.getElementById('btn-prev')
const btnNext     = document.getElementById('btn-next')
const muteButton  = document.getElementById('mute-button')
const volumeSlider = document.getElementById('volume-slider')
const timeDisplay = document.getElementById('time-display')
const currentTimeDisplay = document.getElementById('current-time')
const durationDisplay    = document.getElementById('duration')
const reconnectBanner  = document.getElementById('reconnect-banner')
const btnResumeOnline  = document.getElementById('btn-resume-online')

const DEFAULT_COVER = 'images/icon.png'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileUrl(filePath) {
    return 'file:///' + filePath.replace(/\\/g, '/')
}

function formatTime(time) {
    if (isNaN(time) || !isFinite(time)) return '00:00'
    const m = Math.floor(time / 60)
    const s = Math.floor(time % 60)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function getVolume() {
    return isMuted ? 0 : Number(volumeSlider.value) / 100
}

// ── UI state sync (mirrors updatePlayPauseButtons in playerControls.js) ───────

function updatePlayPauseButtons(isPlaying) {
    playButton.classList.toggle('w3-disabled', isPlaying)
    pauseButton.classList.toggle('w3-disabled', !isPlaying)
    stopButton.classList.toggle('w3-disabled', !isPlaying && isStopped)
    btnNext.classList.toggle('w3-disabled', isStopped && !isPlaying)
}

function updateNavButtons() {
    btnPrev.classList.toggle('w3-disabled', currentIndex <= 0)
    btnNext.classList.toggle('w3-disabled', currentIndex >= songs.length - 1)
}

function updateTimeDisplay() {
    const current  = player.currentTime
    const duration = player.duration
    currentTimeDisplay.textContent = formatTime(current)
    durationDisplay.textContent    = formatTime(duration)
    timeDisplay.style.width        = duration ? `${(current / duration) * 100}%` : '0%'
    timeDisplay.style.transition   = 'width 0.5s ease-in-out'
}

function updateMuteButton() {
    const icon = muteButton.querySelector('i')
    if (icon) icon.textContent = isMuted ? 'volume_off' : 'volume_up'
}

// ── Song info display ─────────────────────────────────────────────────────────

function displaySongInfo(song) {
    songTitle.textContent  = song.title  || '—'
    songArtist.textContent = song.artist || ''
    songAlbum.textContent  = song.album  || ''
    if (song.coverPath) {
        songCover.onerror = () => { songCover.onerror = null; songCover.src = DEFAULT_COVER }
        songCover.src = fileUrl(song.coverPath)
    } else {
        songCover.src = DEFAULT_COVER
    }
}

// ── Song list rendering ───────────────────────────────────────────────────────

function renderList() {
    songList.querySelectorAll('.song-item').forEach(el => el.remove())

    if (songs.length === 0) {
        emptyMsg.style.display = 'block'
        return
    }
    emptyMsg.style.display = 'none'

    songs.forEach((song, i) => {
        const isActive = i === currentIndex
        const item = document.createElement('div')
        item.className = `song-item w3-bar w3-card w3-round w3-margin-bottom w3-hover-theme${isActive ? ' w3-theme' : ' w3-theme-d3'}`
        item.dataset.index = i

        const num = document.createElement('div')
        num.className = 'w3-bar-item w3-small w3-opacity'
        num.style.cssText = 'width:32px; text-align:right; flex-shrink:0;'
        num.textContent = i + 1

        const icon = document.createElement('div')
        icon.className = 'w3-bar-item'
        icon.style.cssText = 'flex-shrink:0; font-size:1rem;'
        const iconEl = document.createElement('i')
        iconEl.className = 'material-symbols-rounded'
        iconEl.textContent = isActive ? 'graphic_eq' : 'music_note'
        icon.appendChild(iconEl)

        const info = document.createElement('div')
        info.className = 'w3-bar-item'
        info.style.cssText = 'overflow:hidden;'

        const name = document.createElement('div')
        name.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:bold;'
        name.textContent = song.title || `Canción ${i + 1}`

        const sub = document.createElement('div')
        sub.className = 'w3-small w3-opacity'
        sub.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'
        sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ')

        info.appendChild(name)
        if (sub.textContent) info.appendChild(sub)

        item.appendChild(num)
        item.appendChild(icon)
        item.appendChild(info)
        item.addEventListener('click', () => playSong(i))
        songList.appendChild(item)
    })
}

function updateActiveItem() {
    songList.querySelectorAll('.song-item').forEach((el, i) => {
        const isActive = i === currentIndex
        el.classList.toggle('w3-theme', isActive)
        el.classList.toggle('w3-theme-d3', !isActive)
        const icon = el.querySelector('.material-symbols-rounded')
        if (icon) icon.textContent = isActive ? 'graphic_eq' : 'music_note'
    })
}

// ── Playback ──────────────────────────────────────────────────────────────────

function playSong(index) {
    if (index < 0 || index >= songs.length) return
    currentIndex = index
    isStopped = false
    const song = songs[index]

    player.src = fileUrl(song.filePath)
    player.volume = getVolume()
    player.load()
    player.play().catch(err => console.warn('[offline] play():', err))

    displaySongInfo(song)
    updatePlayPauseButtons(true)
    updateNavButtons()
    updateActiveItem()
}

function stopAudio() {
    player.pause()
    player.currentTime = 0
    isStopped = true
    currentTimeDisplay.textContent = '00:00'
    durationDisplay.textContent    = '00:00'
    timeDisplay.style.width        = '0%'
    updatePlayPauseButtons(false)
}

// ── Audio events (mirrors playerControls.js pattern) ─────────────────────────

player.addEventListener('play',  () => updatePlayPauseButtons(true))
player.addEventListener('pause', () => { if (!isStopped) updatePlayPauseButtons(false) })
player.addEventListener('timeupdate', updateTimeDisplay)

player.addEventListener('ended', () => {
    if (pendingResume) {
        window.versions.resumeOnlineService()
        return
    }
    if (currentIndex < songs.length - 1) {
        playSong(currentIndex + 1)
    } else {
        isStopped = true
        updatePlayPauseButtons(false)
    }
})

// ── Control button bindings ───────────────────────────────────────────────────

playButton.addEventListener('click', () => {
    if (!isStopped && player.paused && player.currentTime > 0) {
        player.play().catch(() => {})
    } else if (songs.length > 0) {
        playSong(currentIndex >= 0 ? currentIndex : 0)
    }
})

pauseButton.addEventListener('click', () => { player.pause() })
stopButton.addEventListener('click', stopAudio)
btnPrev.addEventListener('click', () => playSong(currentIndex - 1))
btnNext.addEventListener('click', () => playSong(currentIndex + 1))

muteButton.addEventListener('click', () => {
    isMuted = !isMuted
    player.volume = getVolume()
    updateMuteButton()
})

volumeSlider.addEventListener('input', () => {
    isMuted = false
    player.volume = getVolume()
    updateMuteButton()
    window.versions.setVolume(Number(volumeSlider.value))
})

// ── Load cached songs and auto-play on startup ────────────────────────────────
// The autoplay-policy switch in main.js allows immediate play without a user gesture.

// Restore persisted volume before loading songs
window.versions.getVolume().then((savedVolume) => {
    volumeSlider.value = savedVolume
    player.volume = getVolume()
})

window.versions.getCachedSongs().then((cachedSongs) => {
    songs = cachedSongs || []
    renderList()
    if (songs.length > 0) {
        playSong(0)   // start playing immediately for seamless offline transition
    } else {
        emptyMsg.style.display = 'block'
    }
}).catch(() => {
    emptyMsg.style.display = 'block'
    emptyMsg.textContent   = 'Error al leer canciones guardadas.'
})

// ── Deferred online resume ────────────────────────────────────────────────────
// Main process pushes this event when connectivity is restored while offline.

window.versions.onConnectivityRestored(() => {
    if (pendingResume) return
    pendingResume = true

    reconnectBanner.classList.add('visible')

    // If nothing is playing right now, switch immediately
    if (player.paused || player.ended || !player.src) {
        window.versions.resumeOnlineService()
    }
})

// "Volver ahora" — skip the wait
btnResumeOnline.addEventListener('click', () => {
    pendingResume = false
    reconnectBanner.classList.remove('visible')
    window.versions.resumeOnlineService()
})

// ── Media key handling ────────────────────────────────────────────────────────

window.versions.onMediaKey((key) => {
    switch (key) {
        case 'playpause':
            if (!player.paused) {
                player.pause()
            } else if (songs.length > 0) {
                playSong(currentIndex >= 0 ? currentIndex : 0)
            }
            break
        case 'next':
            if (currentIndex < songs.length - 1) playSong(currentIndex + 1)
            break
        case 'prev':
            if (currentIndex > 0) playSong(currentIndex - 1)
            break
        case 'stop':
            stopAudio()
            break
    }
})
