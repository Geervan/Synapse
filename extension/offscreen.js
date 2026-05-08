import { pipeline, env } from '@xenova/transformers';

// Offscreen documents CAN run WebAssembly (unlike service workers)
// Force-disable worker usage to avoid CSP/importScripts failures
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserWorker = false;

class PipelineSingleton {
    static task = 'feature-extraction';
    static model = 'Xenova/all-MiniLM-L6-v2';
    static instance = null;
    static loading = false;

    static async getInstance(retries = 3) {
        if (this.instance) return this.instance;
        if (this.loading) {
            // Wait for existing load
            while (this.loading) await new Promise(r => setTimeout(r, 500));
            return this.instance;
        }

        this.loading = true;
        let lastError = null;
        
        for (let i = 0; i < retries; i++) {
            try {
                this.instance = await pipeline(this.task, this.model);
                this.loading = false;
                return this.instance;
            } catch (error) {
                lastError = error;
                console.warn(`Model load attempt ${i + 1} failed:`, error.message);
                if (i < retries - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
            }
        }
        
        this.loading = false;
        throw lastError || new Error("Failed to load AI model after retries");
    }
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'generate_embedding' && message.action !== 'getEmbedding') return;

    (async () => {
        try {
            const extractor = await PipelineSingleton.getInstance();
            const output = await extractor(message.text, { pooling: 'mean', normalize: true });
            const embedding = Array.from(output.data);
            sendResponse({ success: true, embedding });
        } catch (error) {
            console.error('Offscreen Error:', error);
            sendResponse({ success: false, error: error.message });
        }
    })();

    return true;
});
