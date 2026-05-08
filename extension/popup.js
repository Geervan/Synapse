document.getElementById('login-google').addEventListener('click', () => startLogin('google'));
document.getElementById('login-github').addEventListener('click', () => startLogin('github'));
document.getElementById('logout').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'sign_out' }, () => {
        window.close();
    });
});

// Initial Login Check
chrome.runtime.sendMessage({ action: 'get_auth' }, (response) => {
    if (response && response.user) {
        const badge = document.querySelector('.status-badge');
        const logoutBtn = document.getElementById('logout');
        if (badge) {
            badge.innerText = `LINKED: ${response.user.email.split('@')[0]}`;
            badge.style.background = 'rgba(0, 255, 128, 0.1)';
        }
        if (logoutBtn) logoutBtn.style.display = 'flex';
    }
});

function startLogin(provider) {
    const badge = document.querySelector('.status-badge');
    if (badge) badge.innerText = `Linking ${provider}...`;

    chrome.runtime.sendMessage({ action: 'oauth_login', provider }, (response) => {
        if (response && response.success) {
            if (badge) badge.innerText = 'Link Active!';
            setTimeout(() => window.close(), 1500);
        } else {
            if (badge) {
                badge.innerText = 'Link Failed';
                badge.style.color = '#ff4d4d';
            }
            console.error("Login Error:", response.error);
        }
    });
}
