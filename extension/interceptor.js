// This runs in the actual page context to intercept fetch requests
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0] instanceof Request ? args[0].url : args[0];
    
    // We only care about conversation API endpoints
    if (url.includes('claude.ai/api') || 
        url.includes('/backend-api/conversation') || 
        url.includes('gemini.google.com/_/BardChatUi') ||
        url.includes('deepseek.com/api/v0/chat/completion')) { 
        // Clone the response so we don't break the actual app
        const clone = response.clone();
        clone.text().then(text => {
            try {
                window.postMessage({
                    type: 'CONTEXT_BRIDGE_API_INTERCEPT',
                    url: url,
                    data: text
                }, '*');
            } catch (e) {}
        });
    }
    return response;
};
