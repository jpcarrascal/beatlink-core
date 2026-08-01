# BeatLink - Consolidated Audience Participation Server

## Overview
BeatLink is a unified server platform for hosting multiple audience participation music and sound performance applications. It consolidates the existing apps (midisocket, count-me-in, dbass, HootBeat/audience-control) into a single modular server infrastructure.

## Current State Analysis

### Existing Applications
All apps share similar architecture:
- **Socket.io** for real-time WebSocket communication
- **Express.js** for serving HTML/static files
- **Winston** for logging
- **Session/Room management** for coordinating participants

#### App Characteristics:

1. **midisocket** (newest implementation)
   - MIDI sequencer with track-based participant allocation
   - Advanced MIDI routing and device configuration
   - Connection type detection (sequencer vs track)
   - sessionObj.js with Participant, Sequencer, and Session classes
   - NUM_TRACKS and NUM_STEPS configuration
   
2. **count-me-in**
   - Similar structure to midisocket
   - Multiple interface types (track, hootbeat, emoji)
   - Audio generation/caching functionality
   - Sound set selection
   - sessionObj.js with same structure as midisocket

3. **dbass** 
   - Simplified session management (sessionsObj.js)
   - Sound directory switching
   - Color theming
   - Keep-alive session feature
   - External control messages (ext-play, ext-stop, etc.)

4. **HootBeat/audience-control** (oldest implementation)
   - Uses roomsObj.js (older naming)
   - Band member tracking (fixed roles: jp, daniel, mauro, tubes)
   - Flash/color messaging
   - Simpler architecture

## Proposed Architecture

### Core Components

#### 1. **Main Server (index.js)**
Responsibilities:
- HTTP server setup (Express + Socket.io)
- App registration and routing
- Shared middleware configuration
- Global logging setup
- Session lifecycle management

#### 2. **Session Manager (sessionManager.js)**
Unified session management based on midisocket's sessionObj.js:
- `Participant` class: socketID, initials, rounds tracking
- `Sequencer` class: tracks, steps, note management (optional per app)
- `Session` class: participants, allocation methods, attributes
- `AllSessions` manager: multi-session coordination

Key features:
- Flexible participant allocation (random, ascending, custom)
- Generic attribute storage for app-specific data
- Round/timeout tracking
- Sequencer integration (when needed)

#### 3. **App Modules**
Each app as a pluggable module with:
```javascript
module.exports = {
  name: 'appName',
  routes: [...],           // Express routes
  socketHandlers: {...},   // Socket event handlers
  config: {...},           // App-specific config
  initialize: (io, sessions, config) => {...}
}
```

Apps:
- `apps/midisocket/` - MIDI sequencing
- `apps/countmein/` - Collaborative performance
- `apps/dbass/` - Bass performance control
- `apps/hootbeat/` - Band audience interaction

#### 4. **Shared Utilities**
- `utils/logger.js` - Winston logging configuration
- `utils/socketHelpers.js` - Common socket operations
- `utils/fileHelpers.js` - Sound/asset management
- `config/default.js` - Global configuration

### Directory Structure
```
beatlink/
├── index.js                    # Main server entry point
├── package.json
├── config/
│   ├── default.js             # Global config
│   └── apps.js                # App registry
├── core/
│   ├── sessionManager.js      # Unified session management
│   ├── appLoader.js           # Dynamic app loading
│   └── router.js              # Route management
├── apps/
│   ├── midisocket/
│   │   ├── index.js           # App module
│   │   ├── routes.js          # App routes
│   │   ├── socketHandlers.js  # Socket events
│   │   ├── config.js          # App config
│   │   └── public/            # Static files
│   ├── countmein/
│   ├── dbass/
│   └── hootbeat/
├── utils/
│   ├── logger.js
│   ├── socketHelpers.js
│   └── fileHelpers.js
├── public/                     # Shared static files
│   ├── css/
│   ├── scripts/
│   └── images/
└── logs/
```

## Implementation Plan

### Phase 1: Core Infrastructure
1. Create base server structure with Express + Socket.io
2. Implement unified sessionManager.js (based on midisocket version)
3. Create app module interface/contract
4. Set up logging and configuration system
5. Implement app loader and dynamic routing

### Phase 2: App Migration
For each app:
1. Extract app-specific logic from index.js
2. Separate routes from socket handlers
3. Move static files to app public directory
4. Create app module wrapper
5. Test app in isolation

### Phase 3: Integration
1. Register all apps in central config
2. Implement app namespace routing (e.g., /midisocket/*, /dbass/*)
3. Add session isolation per app (or shared sessions)
4. Test multi-app scenarios
5. Performance optimization

### Phase 4: Enhancement
1. Admin dashboard for monitoring all apps/sessions
2. Shared authentication/authorization (if needed)
3. Analytics and metrics
4. Deployment configurations
5. Documentation

## Key Design Decisions

### 1. **App Routing Strategy**
Each app gets its own namespace:
- `/midisocket/` → midisocket app
- `/countmein/` → count-me-in app
- `/dbass/` → dbass app
- `/hootbeat/` → hootbeat app

Alternatively, use subdomains or port-based routing.

### 2. **Session Isolation**
Options:
- **Per-app sessions**: Each app has isolated sessions
- **Global sessions**: Sessions can be shared across apps
- **Hybrid**: Configurable per app

Recommendation: Start with per-app isolation, add sharing later if needed.

### 3. **Socket.io Namespaces**
Use Socket.io namespaces to isolate app communications:
```javascript
io.of('/midisocket').on('connection', ...)
io.of('/countmein').on('connection', ...)
```

### 4. **Configuration Hierarchy**
- Global config (server port, logging level)
- App config (NUM_TRACKS, NUM_STEPS, etc.)
- Session config (runtime attributes)

### 5. **Backward Compatibility**
Maintain existing URL patterns and API for each app to minimize client changes:
- `/midisocket/sequencer?session=xyz` works as before
- Query parameters and socket events remain unchanged

## Session Manager API

### Core Methods
```javascript
class AllSessions {
  // Session lifecycle
  addSession(name, config)
  clearSession(name)
  select(name)
  findSession(name)
  
  // Participant management
  allocateAvailableParticipant(session, socketID, initials)
  releaseParticipant(session, socketID)
  getParticipantNumber(session, socketID)
  
  // Sequencer operations (optional)
  seqUpdateStep(session, track, event)
  getStepNotes(session, step)
  
  // Attributes
  setAttribute(session, key, value)
  getAttribute(session, key)
  
  // State
  isPlaying(session)
  play(session)
  stop(session)
}
```

## Socket Event Standardization

### Common Events (all apps)
- `connection` - Client connects
- `disconnect` - Client disconnects
- `ping/pong` - Latency check
- `exit session` - Force client to leave

### Session Control Events
- `play` - Start session
- `stop` - Stop session
- `veil-on/off` - Pause/resume

### Participant Events
- `track joined` - New participant
- `track left` - Participant disconnected
- `track ready` - Participant loaded

### App-Specific Events
Each app can define additional events that don't conflict with core events.

## Migration Strategy

### Minimal Changes Approach
1. Apps keep their existing client-side code
2. Server refactored to use shared session manager
3. App logic extracted into modules
4. Routes prefixed with app namespace

### Testing Strategy
1. Unit tests for session manager
2. Integration tests per app
3. End-to-end tests for full scenarios
4. Load testing for multiple concurrent sessions

## Configuration Example

### apps.js
```javascript
module.exports = {
  apps: [
    {
      name: 'midisocket',
      enabled: true,
      path: './apps/midisocket',
      config: {
        NUM_TRACKS: 16,
        NUM_STEPS: 16,
        MAX_NUM_ROUNDS: 100
      }
    },
    {
      name: 'countmein',
      enabled: true,
      path: './apps/countmein',
      config: {
        NUM_TRACKS: 10,
        NUM_STEPS: 16,
        MAX_NUM_ROUNDS: 5
      }
    },
    // ... other apps
  ]
}
```

## Benefits of Consolidation

1. **Single Deployment**: One server to deploy and maintain
2. **Shared Resources**: Common session management, logging, utilities
3. **Code Reuse**: DRY principles across apps
4. **Unified Monitoring**: One place to monitor all apps
5. **Easy Scaling**: Add new apps by dropping in modules
6. **Consistent Updates**: Update core functionality once for all apps
7. **Resource Efficiency**: Shared server resources vs multiple servers

## Azure Deployment

### Single Web App Deployment

**Azure Resources:**
```
Azure Resource Group: beatlink-platform
├── Azure Web App
│   ├── Name: beatlink
│   ├── URL: beatlink.azurewebsites.net
│   └── Plan: Standard S1 or Premium P1V2
├── Azure Application Insights
│   └── beatlink-insights
└── Azure Cache for Redis (Optional)
    └── For distributed sessions if scaling horizontally
```

### Configuration (Azure Web App Settings)
```bash
NODE_ENV=production
LOG_LEVEL=info
PORT=8080
# App-specific configs can be set here too
MIDISOCKET_NUM_TRACKS=16
COUNTMEIN_NUM_TRACKS=10
```

### CI/CD Pipeline (GitHub Actions)

**.github/workflows/deploy-azure.yml:**
```yaml
name: Deploy BeatLink to Azure

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
      
      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v2
        with:
          app-name: beatlink
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

### Scaling Strategy

**Vertical Scaling (Scale Up):**
- Start with Standard S1 (~$70/month)
- Scale to Premium P1V2 for more resources
- Simple, single instance

**Horizontal Scaling (Scale Out):**
- Premium tier required for multiple instances
- Use Azure Cache for Redis for session state
- Enable ARR Affinity for Socket.io sticky sessions
- Configure auto-scale rules based on:
  - CPU usage > 70%
  - Active connections > threshold
  - Custom metrics

### Monitoring

**Azure Application Insights Integration:**
```javascript
// In index.js
const appInsights = require('applicationinsights');
appInsights.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
  .setAutoDependencyCorrelation(true)
  .setAutoCollectRequests(true)
  .setAutoCollectPerformance(true)
  .setAutoCollectExceptions(true)
  .start();

// Track custom events
appInsights.defaultClient.trackEvent({
  name: 'SessionCreated',
  properties: { app: 'midisocket', sessionName: 'xyz' }
});
```

### Cost Estimate

**Monthly Costs:**
- Azure Web App (Standard S1): ~$70/month
- Azure Application Insights: ~$5/month (basic)
- **Total: ~$75/month**

Optional:
- Azure Cache for Redis (Basic C1): +$17/month (if scaling out)

## App Module Interface

### Standard App Module Structure

Each app exports a standard interface:

```javascript
// apps/midisocket/index.js
module.exports = {
  name: 'midisocket',
  
  // Express routes
  routes: [
    {
      method: 'get',
      path: '/',
      handler: (req, res) => {
        res.sendFile(__dirname + '/public/html/index-sequencer.html');
      }
    },
    {
      method: 'get',
      path: '/sequencer',
      handler: (req, res) => {
        if(req.query.session)
          res.sendFile(__dirname + '/public/html/sequencer.html');
        else
          res.sendFile(__dirname + '/public/html/index-sequencer.html');
      }
    }
  ],
  
  // Socket.io event handlers
  socketHandlers: {
    connection: (socket, io, sessions) => {
      const session = socket.handshake.query.session;
      const connectionType = socket.handshake.query.type;
      
      socket.join(session);
      
      if (connectionType === 'sequencer') {
        // Sequencer connection logic
        // ...
      } else {
        // Track connection logic
        // ...
      }
      
      socket.on('step update', (msg) => {
        io.to(session).emit('step update', msg);
        // ...
      });
      
      socket.on('disconnect', () => {
        // Cleanup logic
        // ...
      });
    }
  },
  
  // Static file directory
  publicDir: __dirname + '/public',
  
  // App-specific configuration
  config: {
    NUM_TRACKS: 16,
    NUM_STEPS: 16,
    MAX_NUM_ROUNDS: 100
  },
  
  // Optional: Initialization function
  initialize: async (server, io, sessions) => {
    // Any setup needed when server starts
    console.log('Midisocket app initialized');
  }
};
```

### App Loader Implementation

```javascript
// core/appLoader.js
const fs = require('fs');
const path = require('path');

class AppLoader {
  constructor(express, io, sessions, logger) {
    this.app = express;
    this.io = io;
    this.sessions = sessions;
    this.logger = logger;
    this.loadedApps = [];
  }
  
  async loadApps(appsConfig) {
    for (const appConfig of appsConfig) {
      if (!appConfig.enabled) continue;
      
      try {
        const appModule = require(path.resolve(appConfig.path));
        await this.loadApp(appModule, appConfig);
        this.loadedApps.push(appModule.name);
        this.logger.info(`Loaded app: ${appModule.name}`);
      } catch (error) {
        this.logger.error(`Failed to load app ${appConfig.name}:`, error);
      }
    }
  }
  
  async loadApp(appModule, appConfig) {
    const namespace = `/${appModule.name}`;
    
    // Register routes
    if (appModule.routes) {
      appModule.routes.forEach(route => {
        const fullPath = namespace + route.path;
        this.app[route.method](fullPath, route.handler);
      });
    }
    
    // Register static files
    if (appModule.publicDir) {
      this.app.use(namespace, express.static(appModule.publicDir));
    }
    
    // Register socket handlers
    if (appModule.socketHandlers) {
      const appIo = this.io.of(namespace);
      appIo.on('connection', (socket) => {
        appModule.socketHandlers.connection(socket, appIo, this.sessions);
      });
    }
    
    // Run initialization
    if (appModule.initialize) {
      await appModule.initialize(this.app, this.io, this.sessions);
    }
  }
  
  getLoadedApps() {
    return this.loadedApps;
  }
}

module.exports = AppLoader;
```

## Main Server Implementation

```javascript
// index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { AllSessions } = require('./core/sessionManager');
const AppLoader = require('./core/appLoader');
const logger = require('./utils/logger');
const appsConfig = require('./config/apps');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize session manager
const sessions = new AllSessions();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Shared static files
app.use('/shared', express.static(__dirname + '/public'));

// Root route
app.get('/', (req, res) => {
  res.send(`
    <h1>BeatLink Server</h1>
    <p>Available apps:</p>
    <ul>
      ${appsConfig.apps.filter(a => a.enabled).map(a => 
        `<li><a href="/${a.name}/">${a.name}</a></li>`
      ).join('')}
    </ul>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    apps: appLoader.getLoadedApps(),
    timestamp: new Date().toISOString()
  });
});

// Load apps
const appLoader = new AppLoader(app, io, sessions, logger);

(async () => {
  await appLoader.loadApps(appsConfig.apps);
  
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    logger.info(`BeatLink server listening on port ${port}`);
    logger.info(`Loaded apps: ${appLoader.getLoadedApps().join(', ')}`);
  });
})();

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
```

## Future Enhancements

1. **Multi-tenancy**: Support multiple performances simultaneously
2. **Recording/Playback**: Record sessions for later analysis
3. **Cross-app Communication**: Apps can interact with each other
4. **Plugin System**: Community-contributed app modules
5. **Admin Dashboard**: Web UI for monitoring all apps/sessions
6. **Authentication**: Shared auth system across apps
7. **WebRTC Integration**: Low-latency audio streaming
8. **Mobile Apps**: Native mobile clients
9. **Docker Support**: Containerization for easier deployment
10. **Kubernetes**: Orchestration for large-scale deployments

## Getting Started (Development)

1. **Clone repository:**
```bash
git clone https://github.com/yourorg/beatlink
cd beatlink
npm install
```

2. **Run locally:**
```bash
npm start
# Server runs on http://localhost:3000
```

3. **Access apps:**
- Midisocket: http://localhost:3000/midisocket/
- Count-me-in: http://localhost:3000/countmein/
- dbass: http://localhost:3000/dbass/
- HootBeat: http://localhost:3000/hootbeat/

4. **Add new app:**
```bash
mkdir -p apps/myapp/public
# Create apps/myapp/index.js with standard interface
# Add to config/apps.js
# Restart server
```

## Notes

- Keep midisocket sessionObj.js as the base (newest, most complete)
- Support both sequencer and non-sequencer modes
- Maintain flexible attribute system for app-specific data
- Logging should include app name for easy filtering
- Use Socket.io namespaces for app isolation
- Consider shared public directory for common assets (CSS, scripts)
- Apps can override shared utilities if needed
- Environment variables for production vs development configs
- Use Winston for structured logging
- Implement rate limiting and security middleware
