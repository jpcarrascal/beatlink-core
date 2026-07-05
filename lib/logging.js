const { createLogger: createWinstonLogger, format, transports } = require('winston');
const { combine, timestamp, label, printf } = format;

const lineFormat = printf(({ message, timestamp }) => {
    return `${timestamp} ${message}`;
});

// Standardized BeatLink logger: `#session @[initials] event...` lines go through
// this so cross-app log analysis tooling works uniformly (spec §5.13).
function createLogger({ label: appLabel = 'beatlink', file = 'info.log', silent = false } = {}) {
    const logTransports = [new transports.Console({ silent })];
    if (file) {
        logTransports.push(new transports.File({ filename: file }));
    }

    return createWinstonLogger({
        format: combine(
            label({ label: appLabel }),
            timestamp(),
            lineFormat
        ),
        transports: logTransports
    });
}

module.exports = { createLogger };
