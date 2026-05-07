'use strict'

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const CONTENT_TYPE_TO_EXT = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/opus': 'opus',
    'audio/webm': 'webm',
}

// Extensions that indicate an audio URL even without a proper content-type
const AUDIO_EXT_RE = /\.(mp3|ogg|wav|flac|aac|m4a|opus|webm)(\?|#|$)/i

// Maximum cache size in bytes (500 MB)
const MAX_CACHE_BYTES = 500 * 1024 * 1024

class CacheManager {
    constructor(userData) {
        this.cacheDir = path.join(userData, 'audio-cache')
        this.indexPath = path.join(userData, 'cache-index.json')
        this.index = { songs: [] }
        this._ensureDir()
        this._loadIndex()
    }

    _ensureDir() {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true })
        }
    }

    _loadIndex() {
        try {
            const data = fs.readFileSync(this.indexPath, 'utf8')
            const parsed = JSON.parse(data)
            this.index = parsed
            if (!Array.isArray(this.index.songs)) this.index.songs = []
            // Validate: mark missing files as unavailable so they can be re-downloaded
            for (const song of this.index.songs) {
                if (song.available && !fs.existsSync(song.filePath)) {
                    song.available = false
                }
            }
        } catch {
            this.index = { songs: [] }
        }
    }

    _saveIndex() {
        const tmp = this.indexPath + '.tmp'
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8')
            fs.renameSync(tmp, this.indexPath)
        } catch (e) {
            console.error('[cache] Failed to save index:', e.message)
        }
    }

    /**
     * Derives a stable ID from the URL by ignoring query params that
     * change per-request (e.g. auth tokens with timestamps).
     */
    _urlToId(url) {
        let stable = url
        try {
            const u = new URL(url)
            stable = u.origin + u.pathname
        } catch {}
        return crypto.createHash('sha256').update(stable).digest('hex').substring(0, 20)
    }

    _extractTitle(url) {
        try {
            const pathname = new URL(url).pathname
            const base = pathname.split('/').pop() || ''
            const name = decodeURIComponent(base.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')).trim()
            return name || pathname
        } catch {
            return url
        }
    }

    static extForContentType(contentType) {
        if (!contentType) return 'mp3'
        const base = contentType.split(';')[0].trim().toLowerCase()
        return CONTENT_TYPE_TO_EXT[base] || 'mp3'
    }

    /**
     * Returns true if the URL or content-type indicates an audio resource.
     */
    isAudio(url, contentType) {
        if (contentType && contentType.toLowerCase().startsWith('audio/')) return true
        try { return AUDIO_EXT_RE.test(new URL(url).pathname) } catch { return false }
    }

    getByUrl(url) {
        const id = this._urlToId(url)
        return this.index.songs.find(s => s.id === id) || null
    }

    isAvailable(url) {
        const song = this.getByUrl(url)
        return !!(song && song.available && fs.existsSync(song.filePath))
    }

    /**
     * Registers a song URL in the index (pending download).
     * Returns the song entry, or null if it was already registered.
     */
    register(url, contentType) {
        const id = this._urlToId(url)
        if (this.index.songs.find(s => s.id === id)) return null
        const ext = CacheManager.extForContentType(contentType)
        const filePath = path.join(this.cacheDir, id + '.' + ext)
        const song = {
            id,
            url,
            filePath,
            title: this._extractTitle(url),
            ext,
            size: 0,
            addedAt: Date.now(),
            available: false,
        }
        this.index.songs.push(song)
        this._saveIndex()
        return song
    }

    markAvailable(url, size) {
        const id = this._urlToId(url)
        const song = this.index.songs.find(s => s.id === id)
        if (song) {
            song.available = true
            song.size = size || 0
            this._saveIndex()
            this._cleanup()
        }
    }

    /** Removes a failed/incomplete entry so it can be retried next time. */
    markFailed(url) {
        const id = this._urlToId(url)
        const song = this.index.songs.find(s => s.id === id)
        if (song && !song.available) {
            this.index.songs = this.index.songs.filter(s => s.id !== id)
            this._saveIndex()
        }
    }

    /** Returns all successfully downloaded songs, newest first. */
    getAvailableSongs() {
        return this.index.songs
            .filter(s => s.available && fs.existsSync(s.filePath))
            .sort((a, b) => b.addedAt - a.addedAt)
    }

    /** Evicts oldest songs when the cache exceeds MAX_CACHE_BYTES. */
    _cleanup() {
        const songs = this.index.songs.filter(s => s.available).sort((a, b) => a.addedAt - b.addedAt)
        let total = songs.reduce((sum, s) => sum + (s.size || 0), 0)
        while (total > MAX_CACHE_BYTES && songs.length > 0) {
            const oldest = songs.shift()
            try { fs.unlinkSync(oldest.filePath) } catch {}
            oldest.available = false
            total -= oldest.size || 0
        }
        this._saveIndex()
    }
}

module.exports = CacheManager
