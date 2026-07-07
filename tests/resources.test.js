const path = require('path');
const fs = require('fs');
const Client = require('socket.io-client');
const { createServer } = require('../index');
const { ResourceCatalog } = require('../lib/resources');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('ResourceCatalog (unit)', () => {
    const soundsets = new ResourceCatalog('soundsets', {
        dir: path.join(FIXTURES, 'soundsets'),
        ext: ['.wav', '.mp3'],
        group: 'subdirs'
    });

    test('grouped catalog lists groups first, then files per group', () => {
        expect(soundsets.list()).toEqual({ name: 'soundsets', groups: ['setA', 'setB'] });
        expect(soundsets.list('setA')).toEqual({
            name: 'soundsets',
            group: 'setA',
            files: ['setA/kick.wav', 'setA/snare.mp3'] // readme.txt filtered by ext
        });
    });

    test('flat catalog lists files directly', () => {
        const flat = new ResourceCatalog('flat', { dir: path.join(FIXTURES, 'flat') });
        expect(flat.list()).toEqual({ name: 'flat', group: null, files: ['one.png', 'two.jpg'] });
    });

    test('rejects path traversal in group names', () => {
        expect(soundsets.list('../../lib')).toBeNull();
        expect(soundsets.list('..')).toBeNull();
        expect(soundsets.list('missing-group')).toBeNull();
    });

    test('saveUpload validates uploadable flag, extension, size and filename', () => {
        expect(soundsets.saveUpload('a.wav', Buffer.from('x'))).toEqual({ error: 'not-uploadable' });

        const uploads = new ResourceCatalog('uploads', {
            dir: path.join(FIXTURES, 'soundsets'),
            ext: ['.wav'],
            group: 'subdirs',
            uploadable: true,
            maxUploadBytes: 4
        });
        expect(uploads.saveUpload('evil.sh', Buffer.from('x'), 'setA')).toEqual({ error: 'invalid-filename' });
        expect(uploads.saveUpload('big.wav', Buffer.from('12345'), 'setA')).toEqual({ error: 'too-large' });
        expect(uploads.saveUpload('a.wav', Buffer.from('x'), '../..')).toEqual({ error: 'invalid-group' });

        const saved = uploads.saveUpload('../w e?ird.wav', Buffer.from('ok'), 'setA');
        expect(saved).toEqual({ file: 'setA/w_e_ird.wav' }); // basename + sanitized
        fs.unlinkSync(path.join(FIXTURES, 'soundsets', 'setA', 'w_e_ird.wav'));
    });
});

describe('resource + QR HTTP/socket surfaces', () => {
    let server, port, clients = [];

    beforeAll((done) => {
        server = createServer({
            handleSignals: false,
            logging: { silent: true, file: false },
            session: { numParticipants: 2 },
            resources: {
                soundsets: {
                    dir: path.join(FIXTURES, 'soundsets'),
                    ext: ['.wav', '.mp3'],
                    group: 'subdirs',
                    uploadable: true
                }
            }
        });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => server.sessions.remove(s.name));
    });

    afterAll(async () => {
        await server.close();
    });

    function connect(query) {
        const socket = Client(`http://localhost:${port}`, {
            query, forceNew: true, transports: ['websocket']
        });
        clients.push(socket);
        return socket;
    }

    function waitFor(socket, event) {
        return new Promise(resolve => socket.once(event, resolve));
    }

    test('HTTP listing: groups, files, and 404s', async () => {
        const groups = await (await fetch(`http://localhost:${port}/beatlink/resources/soundsets`)).json();
        expect(groups.groups).toEqual(['setA', 'setB']);

        const files = await (await fetch(`http://localhost:${port}/beatlink/resources/soundsets?group=setB`)).json();
        expect(files.files).toEqual(['setB/pad.wav']);

        expect((await fetch(`http://localhost:${port}/beatlink/resources/nope`)).status).toBe(404);
        expect((await fetch(`http://localhost:${port}/beatlink/resources/soundsets?group=zzz`)).status).toBe(404);
    });

    test('socket listing via request-resource-catalog', async () => {
        const host = connect({ role: 'host', session: 'r1' });
        await waitFor(host, 'host-accepted');

        const listingPromise = waitFor(host, 'resource-catalog');
        host.emit('request-resource-catalog', { name: 'soundsets', group: 'setA' });
        const listing = await listingPromise;
        expect(listing.files).toEqual(['setA/kick.wav', 'setA/snare.mp3']);

        const errorPromise = waitFor(host, 'resource-error');
        host.emit('request-resource-catalog', { name: 'nope' });
        expect((await errorPromise).reason).toBe('unknown-resource');
    });

    test('upload requires the host token; success notifies the session', async () => {
        const host = connect({ role: 'host', session: 'r2' });
        const accepted = await waitFor(host, 'host-accepted');
        expect(typeof accepted.hostToken).toBe('string');

        const badAuth = await fetch(
            `http://localhost:${port}/beatlink/resources/soundsets/upload?session=r2&token=wrong&filename=up.wav&group=setA`,
            { method: 'POST', body: Buffer.from('audio') }
        );
        expect(badAuth.status).toBe(403);

        const updatePromise = waitFor(host, 'resource-updated');
        const ok = await fetch(
            `http://localhost:${port}/beatlink/resources/soundsets/upload?session=r2&token=${accepted.hostToken}&filename=up.wav&group=setA`,
            { method: 'POST', body: Buffer.from('audio') }
        );
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ file: 'setA/up.wav' });
        expect(await updatePromise).toEqual({ name: 'soundsets', file: 'setA/up.wav' });

        expect(fs.readFileSync(path.join(FIXTURES, 'soundsets', 'setA', 'up.wav'), 'utf8')).toBe('audio');
        fs.unlinkSync(path.join(FIXTURES, 'soundsets', 'setA', 'up.wav'));
    });

    test('QR service returns a PNG for a join URL', async () => {
        const response = await fetch(`http://localhost:${port}/beatlink/qr.png?text=${encodeURIComponent('https://example.com/track?session=gig')}&size=128`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('image/png');
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
        expect((await fetch(`http://localhost:${port}/beatlink/qr.png`)).status).toBe(400);
    });
});
