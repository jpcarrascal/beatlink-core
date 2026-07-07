const fs = require('fs');
const path = require('path');

// Resource catalog (spec §5.11): declarative asset directories. Core lists,
// groups and serves catalog metadata and accepts host-only uploads; what a
// resource *means* (a sound set, a pedal image) stays app-side.
//
//   resources: {
//     sounds: { dir: './sounds', ext: ['.mp3', '.wav'], group: 'subdirs', uploadable: true },
//     pedals: { dir: './images/pedals', ext: ['.png', '.jpg', '.svg'] }
//   }

const CATALOG_DEFAULTS = {
    ext: [],                        // allowed extensions; empty = all files
    group: false,                   // 'subdirs' = first-level dirs are groups
    uploadable: false,              // host-only upload endpoint enabled
    maxUploadBytes: 10 * 1024 * 1024
};

// Group and file names must be plain names — no path traversal.
function isPlainName(name) {
    return typeof name === 'string'
        && name.length > 0
        && !name.includes('/')
        && !name.includes('\\')
        && !name.includes('..')
        && name !== '.';
}

class ResourceCatalog {
    constructor(name, config = {}) {
        if (!config.dir) {
            throw new Error(`Resource '${name}' requires a 'dir'`);
        }
        this.name = name;
        this.config = { ...CATALOG_DEFAULTS, ...config };
        this.dir = path.resolve(this.config.dir);
    }

    matchesExt(filename) {
        if (this.config.ext.length === 0) return true;
        const lower = filename.toLowerCase();
        return this.config.ext.some(ext => lower.endsWith(ext.toLowerCase()));
    }

    groups() {
        if (this.config.group !== 'subdirs') return [];
        return fs.readdirSync(this.dir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    }

    files(group = null) {
        let dir = this.dir;
        if (group !== null) {
            if (!isPlainName(group)) return null;
            dir = path.join(this.dir, group);
        }
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            return null;
        }
        return entries
            .filter(entry => entry.isFile() && this.matchesExt(entry.name))
            .map(entry => (group !== null ? `${group}/${entry.name}` : entry.name))
            .sort((a, b) => a.localeCompare(b));
    }

    // Catalog listing: grouped catalogs list their groups until one is chosen.
    list(group = null) {
        if (this.config.group === 'subdirs' && group === null) {
            return { name: this.name, groups: this.groups() };
        }
        const files = this.files(group);
        if (files === null) return null;
        return { name: this.name, group, files };
    }

    saveUpload(filename, buffer, group = null) {
        if (!this.config.uploadable) return { error: 'not-uploadable' };
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { error: 'empty-body' };
        if (buffer.length > this.config.maxUploadBytes) return { error: 'too-large' };

        const base = path.basename(`${filename || ''}`);
        const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!isPlainName(safe) || !this.matchesExt(safe)) return { error: 'invalid-filename' };

        let dir = this.dir;
        let relative = safe;
        if (group !== null) {
            if (!isPlainName(group)) return { error: 'invalid-group' };
            dir = path.join(this.dir, group);
            relative = `${group}/${safe}`;
        }
        if (!fs.existsSync(dir)) return { error: 'invalid-group' };

        fs.writeFileSync(path.join(dir, safe), buffer);
        return { file: relative };
    }
}

function buildCatalogs(resourcesConfig = {}) {
    const catalogs = new Map();
    for (const [name, config] of Object.entries(resourcesConfig)) {
        catalogs.set(name, new ResourceCatalog(name, config));
    }
    return catalogs;
}

module.exports = { ResourceCatalog, buildCatalogs };
