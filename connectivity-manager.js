'use strict'

const { net } = require('electron/main')
const { EventEmitter } = require('node:events')

const CHECK_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 5_000

class ConnectivityManager extends EventEmitter {
    constructor() {
        super()
        this._serviceUrl = null
        this._serviceReachable = true
        this._netOnline = net.online
        this._timer = null
    }

    setServiceUrl(url) {
        this._serviceUrl = url
    }

    /** True when both the network adapter and the configured service are reachable. */
    get isOnline() {
        return this._netOnline && this._serviceReachable
    }

    start() {
        this._scheduleNext()
    }

    stop() {
        if (this._timer) clearTimeout(this._timer)
    }

    /** Force an immediate connectivity check (e.g. after did-fail-load). */
    async checkNow() {
        if (this._timer) clearTimeout(this._timer)
        await this._check()
        this._scheduleNext()
    }

    _scheduleNext() {
        this._timer = setTimeout(() => {
            this._check().then(() => this._scheduleNext())
        }, CHECK_INTERVAL_MS)
    }

    async _check() {
        const wasOnline = this.isOnline

        this._netOnline = net.online

        if (this._netOnline && this._serviceUrl) {
            try {
                await this._ping(this._serviceUrl)
                this._serviceReachable = true
            } catch {
                this._serviceReachable = false
            }
        } else if (!this._netOnline) {
            this._serviceReachable = false
        }

        const nowOnline = this.isOnline
        if (wasOnline !== nowOnline) {
            this.emit(nowOnline ? 'online' : 'offline')
        }
    }

    _ping(url) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS)
            try {
                const req = net.request({ method: 'HEAD', url })
                req.on('response', (res) => {
                    clearTimeout(timer)
                    // Any non-5xx response means the service is up
                    if (res.statusCode < 500) resolve()
                    else reject(new Error(`HTTP ${res.statusCode}`))
                })
                req.on('error', (err) => { clearTimeout(timer); reject(err) })
                req.end()
            } catch (err) {
                clearTimeout(timer)
                reject(err)
            }
        })
    }
}

module.exports = ConnectivityManager
