const path = require('path');

const LATENCY_NAMESPACE = '/beatlink-latency';

// Latency tool (spec §5.12). Uses its own namespace so a venue can be measured
// with no session open: nothing here touches sessions, slots or plugin hooks.
function wireLatency(io, app) {
    io.of(LATENCY_NAMESPACE).on('connection', (socket) => {
        // Sequence numbers only: this endpoint is open to anyone, so it must
        // not echo arbitrary payloads.
        socket.on('ping', (seq) => {
            if (Number.isSafeInteger(seq)) socket.emit('pong', seq);
        });
    });

    app.get('/latency', (req, res) => {
        // Cross-origin isolation gives performance.now() finer resolution
        // where the browser supports it (secure contexts only).
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.set('Cross-Origin-Embedder-Policy', 'require-corp');
        res.sendFile(path.join(__dirname, '../client/latency.html'));
    });

    app.get('/beatlink/latency-stats.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'latencyStats.js'));
    });
}

module.exports = { wireLatency, LATENCY_NAMESPACE };
