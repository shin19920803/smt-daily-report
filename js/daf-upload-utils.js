(function (root) {
    const splitRecordsIntoChunks = (records, { maxRows = 500, maxBytes = 512 * 1024 } = {}) => {
        const encoder = new TextEncoder();
        const chunks = [];
        let current = [];
        let currentBytes = 2;
        for (const record of records || []) {
            const recordText = JSON.stringify(record);
            const recordBytes = encoder.encode(recordText).length;
            const separatorBytes = current.length ? 1 : 0;
            if (recordBytes + 2 > maxBytes) throw new Error('單筆 LOG 超過分批上傳容量，請確認原始檔案內容');
            if (current.length && (current.length >= maxRows || currentBytes + recordBytes + separatorBytes > maxBytes)) {
                chunks.push(current);
                current = [];
                currentBytes = 2;
            }
            current.push(record);
            currentBytes += recordBytes + (current.length > 1 ? 1 : 0);
        }
        if (current.length) chunks.push(current);
        return chunks;
    };

    const hashPayload = async payload => {
        const bytes = new TextEncoder().encode(payload);
        if (root.crypto?.subtle) {
            const digest = await root.crypto.subtle.digest('SHA-256', bytes);
            return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        }
        let hash = 2166136261;
        bytes.forEach(value => { hash ^= value; hash = Math.imul(hash, 16777619); });
        return (hash >>> 0).toString(16).padStart(8, '0');
    };

    const isRetryableUploadError = error => {
        const code = String(error?.code || '');
        if (code === '57014') return false;
        if (/^[0-9A-Z]{5}$/.test(code)) {
            return ['40001', '40P01', '53300', '55P03', '57P01', '57P03'].includes(code);
        }
        const status = Number(error?.status || error?.statusCode || 0);
        if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
        return /network|fetch failed|failed to fetch|connection reset|temporarily unavailable|timeout|逾時|超時/i.test(String(error?.message || error || ''));
    };

    const api = { splitRecordsIntoChunks, hashPayload, isRetryableUploadError };
    root.SMT_DAF_UPLOAD_UTILS = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
