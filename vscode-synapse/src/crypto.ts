import * as crypto from 'crypto';

export class SynapseCrypto {
    static async decrypt(encryptedStr: string, keyBase64: string): Promise<string> {
        if (!encryptedStr || !encryptedStr.startsWith('E2EE:')) {
            return encryptedStr;
        }

        try {
            const key = Buffer.from(keyBase64, 'base64');
            const combined = Buffer.from(encryptedStr.replace('E2EE:', ''), 'base64');
            
            // Layout: IV (12 bytes) | Ciphertext (n bytes) | Tag (16 bytes)
            // Web Crypto appends the 16-byte Auth Tag to the end of the ciphertext
            const iv = combined.subarray(0, 12);
            const authTag = combined.subarray(combined.length - 16);
            const ciphertext = combined.subarray(12, combined.length - 16);

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            
            let decrypted = decipher.update(ciphertext, undefined, 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (error) {
            console.error('Decryption error:', error);
            return '[Error: Decryption failed]';
        }
    }
}
