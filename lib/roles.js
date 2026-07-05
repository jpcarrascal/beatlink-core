// Canonical connection roles (spec §3). Authority lives with `host`, never
// with `public`. Role is declared explicitly in the handshake — never
// inferred from Referer.
const ROLES = ['host', 'public', 'participant'];

function parseHandshake(socket, enabledRoles = ROLES) {
    const query = socket.handshake.query || {};

    const sessionName = typeof query.session === 'string' ? query.session.trim() : '';
    if (!sessionName) {
        return { error: 'missing-session' };
    }

    const role = typeof query.role === 'string' && query.role.trim() !== ''
        ? query.role.trim().toLowerCase()
        : 'participant';
    if (!ROLES.includes(role) || !enabledRoles.includes(role)) {
        return { error: 'invalid-role', role };
    }

    const initials = (typeof query.initials === 'string' && query.initials.trim() !== '')
        ? query.initials.trim()
        : 'GUEST';

    return { role, sessionName, initials };
}

module.exports = { ROLES, parseHandshake };
