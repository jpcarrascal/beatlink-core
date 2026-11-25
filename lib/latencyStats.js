// Summary statistics for round-trip samples (spec §5.12). Shared by the
// /latency page (window.beatlink.latencyStats) and the tests.
(function (root) {
    // `samples`: round-trip times in ms, in the order they were SENT
    // (jitter depends on order).
    function latencyStats(samples) {
        const count = samples.length;
        if (count === 0) return null;
        const sorted = [...samples].sort((a, b) => a - b);
        const middle = Math.floor(count / 2);
        let deltas = 0;
        for (let i = 1; i < count; i++) deltas += Math.abs(samples[i] - samples[i - 1]);
        return {
            count,
            min: sorted[0],
            max: sorted[count - 1],
            mean: samples.reduce((sum, v) => sum + v, 0) / count,
            median: count % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
            p95: sorted[Math.ceil(count * 0.95) - 1], // nearest rank
            // Mean absolute difference between consecutive round trips.
            jitter: count > 1 ? deltas / (count - 1) : 0
        };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { latencyStats };
    } else {
        root.beatlink = root.beatlink || {};
        root.beatlink.latencyStats = latencyStats;
    }
})(typeof window !== 'undefined' ? window : globalThis);
