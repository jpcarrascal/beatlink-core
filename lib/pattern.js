// Pattern / Grid (spec §5.8): authoritative per-session shared state for
// grid-style apps — a tracks × steps store of OPAQUE cell values. What a
// cell means (a note, a drum hit, a color) is app-side; core only enforces
// bounds and write scoping (a participant may write only its own row).
class Pattern {
    constructor(tracks, steps, emptyValue = null) {
        this.tracks = tracks;
        this.steps = steps;
        this.emptyValue = emptyValue;
        this.grid = Array.from({ length: tracks }, () => new Array(steps).fill(emptyValue));
    }

    inBounds(track, step = 0) {
        return Number.isInteger(track) && track >= 0 && track < this.tracks
            && Number.isInteger(step) && step >= 0 && step < this.steps;
    }

    setCell(track, step, value) {
        if (!this.inBounds(track, step)) return false;
        this.grid[track][step] = value;
        return true;
    }

    getCell(track, step) {
        return this.inBounds(track, step) ? this.grid[track][step] : undefined;
    }

    setRow(track, values) {
        if (!this.inBounds(track) || !Array.isArray(values)) return false;
        for (let step = 0; step < this.steps; step++) {
            this.grid[track][step] = step < values.length ? values[step] : this.emptyValue;
        }
        return true;
    }

    getRow(track) {
        return this.inBounds(track) ? [...this.grid[track]] : undefined;
    }

    // clear(track) empties one row; clear() empties the whole grid.
    clear(track = null) {
        if (track === null) {
            this.grid.forEach(row => row.fill(this.emptyValue));
            return true;
        }
        if (!this.inBounds(track)) return false;
        this.grid[track].fill(this.emptyValue);
        return true;
    }

    snapshot() {
        return {
            tracks: this.tracks,
            steps: this.steps,
            grid: this.grid.map(row => [...row])
        };
    }
}

module.exports = { Pattern };
