const input = document.getElementById('urlService')
const form = document.getElementById('url-form')
const errorMsg = document.getElementById('error-msg')

window.versions.getServiceUrl().then((savedUrl) => {
    if (savedUrl) {
        input.value = savedUrl
    }
})

form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorMsg.textContent = ''

    let baseUrl = input.value.trim().replace(/\/+$/, '')

    let parsed
    try {
        parsed = new URL(baseUrl)
    } catch {
        errorMsg.textContent = 'La URL ingresada no es válida.'
        return
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errorMsg.textContent = 'La URL debe usar http o https.'
        return
    }

    await window.versions.setServiceUrl(baseUrl)
})