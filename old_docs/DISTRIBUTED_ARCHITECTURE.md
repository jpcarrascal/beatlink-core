# BeatLink - Distributed Audience Participation Platform

## Overview
BeatLink is a distributed platform for hosting multiple audience participation music and sound performance applications. It consists of a central coordination server and independent app instances, each deployable as separate Azure Web Apps. Apps can be developed, deployed, and scaled independently without touching the core server.

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

### Distributed Microservices Model

#### 1. **BeatLink Server (Central Coordination)**
**Azure Web App Instance** - Central coordination server
**Repository:** `beatlink` (this repo)

Responsibilities:
- **Service Discovery**: App registration and discovery
- **Session Coordination**: Distributed session state management
- **Message Routing**: Cross-app communication hub
- **App Registry**: Track active apps and their endpoints
- **Health Monitoring**: Monitor app instance health
- **Load Balancing**: Route clients to appropriate app instances

Does NOT:
- Run app logic
- Serve app static files
- Handle app-specific socket events

Technologies:
- Express.js for REST API
- Redis for distributed session state (Azure Cache for Redis)
- Socket.io for coordination messaging
- Azure Service Bus (optional) for reliable messaging

#### 2. **App Instances (Independent Services)**
**Separate Azure Web App Instances** per app
**Separate Repositories** per app

Each app is a complete standalone server:
```javascript
// Each app structure
app-name/
├── index.js              // Full Express + Socket.io server
├── package.json
├── sessionObj.js         // Shared npm package
├── config.js
├── routes/
├── socketHandlers/
└── public/               // Static files
```

Apps communicate with BeatLink Server:
- Register on startup (HTTP POST to `/api/apps/register`)
- Heartbeat to maintain registration
- Retrieve/update shared session state via API
- Publish events for cross-app coordination

#### 3. **Shared NPM Packages**
**Published to Azure Artifacts or npmjs.org**

Core packages:
- `@beatlink/session-manager` - Unified session management (based on midisocket)
- `@beatlink/common` - Shared utilities, types, interfaces
- `@beatlink/client-sdk` - Client-side library for connecting to apps

Benefits:
- Apps use same session logic without code duplication
- Update session logic by updating package version
- Apps remain independent but consistent

#### 4. **Distributed State Store**
**Azure Cache for Redis** - Shared state

Stores:
- Active sessions across all apps
- Participant data
- Cross-app shared data
- App registration metadata

Key patterns:
```
beatlink:apps:{appName}                    → App metadata
beatlink:sessions:{appName}:{sessionName}  → Session data
beatlink:participants:{sessionId}          → Participant list
beatlink:health:{appName}                  → Health status
```

### Repository Structure

#### BeatLink Server Repository
```
beatlink/                       # Central coordination server
├── index.js                    # API server entry point
├── package.json
├── config/
│   ├── default.js             # Server config
│   └── azure.js               # Azure-specific config
├── api/
│   ├── apps.js                # App registration endpoints
│   ├── sessions.js            # Session coordination API
│   ├── discovery.js           # Service discovery
│   └── health.js              # Health check endpoints
├── services/
│   ├── registry.js            # App registry service
│   ├── sessionCoordinator.js  # Distributed session coordination
│   ├── messageRouter.js       # Cross-app messaging
│   └── redis.js               # Redis client wrapper
├── utils/
│   └── logger.js
├── web.config                 # Azure Web App config
├── .github/workflows/
│   └── deploy-azure.yml       # CI/CD for server
└── README.md
```

#### Individual App Repositories
Each app in its own repo:

```
app-midisocket/                # Separate repository
├── index.js                   # Full standalone server
├── package.json               # Including @beatlink/* deps
├── routes/
│   ├── sequencer.js
│   └── track.js
├── socketHandlers/
│   └── midi.js
├── public/
│   ├── html/
│   ├── css/
│   ├── scripts/
│   └── images/
├── config.js
├── startup.js                 # Registers with BeatLink server
├── web.config                 # Azure Web App config
├── .github/workflows/
│   └── deploy-azure.yml       # CI/CD for this app
└── README.md
```

Similar structure for:
- `app-countmein/`
- `app-dbass/`
- `app-hootbeat/`

#### Shared Package Repository
```
beatlink-packages/             # Monorepo for shared packages
├── packages/
│   ├── session-manager/       # @beatlink/session-manager
│   │   ├── src/
│   │   │   ├── participant.js
│   │   │   ├── sequencer.js
│   │   │   ├── session.js
│   │   │   └── sessionManager.js
│   │   ├── package.json
│   │   └── README.md
│   ├── common/                # @beatlink/common
│   │   ├── src/
│   │   │   ├── logger.js
│   │   │   ├── redis.js
│   │   │   └── types.js
│   │   └── package.json
│   └── client-sdk/            # @beatlink/client-sdk
│       ├── src/
│       └── package.json
├── lerna.json                 # or use npm workspaces
└── package.json
```

## Implementation Plan

### Phase 1: Shared Packages
1. Create `beatlink-packages` monorepo
2. Extract sessionObj.js into `@beatlink/session-manager` package
   - Add Redis integration for distributed state
   - Add TypeScript definitions
   - Write comprehensive tests
3. Create `@beatlink/common` with shared utilities
4. Publish to Azure Artifacts or npmjs.org
5. Document package APIs

### Phase 2: BeatLink Server
1. Create central coordination server
2. Implement REST API:
   - `POST /api/apps/register` - App registration
   - `DELETE /api/apps/unregister` - Deregistration
   - `GET /api/apps` - List registered apps
   - `POST /api/sessions` - Create/update session
   - `GET /api/sessions/:id` - Get session state
   - `DELETE /api/sessions/:id` - Delete session
3. Implement service registry with Redis
4. Add health check system
5. Set up Azure deployment pipeline
6. Deploy to Azure Web App

### Phase 3: App Migration (One at a Time)
For each app (start with simplest - dbass):
1. Create new repository (e.g., `app-dbass`)
2. Copy existing app code
3. Install `@beatlink/session-manager` and `@beatlink/common`
4. Add startup registration logic
5. Replace local session management with distributed version
6. Update to use Redis for session state
7. Test locally with BeatLink server
8. Create Azure deployment pipeline
9. Deploy to separate Azure Web App
10. Update DNS/routing as needed
11. Monitor and iterate

### Phase 4: Multi-App Testing
1. Deploy multiple apps
2. Test cross-app scenarios
3. Load testing
4. Performance optimization
5. Monitoring and logging setup

### Phase 5: Enhancement
1. Admin dashboard for monitoring all apps/sessions
2. Shared authentication/authorization
3. Analytics and metrics (Azure Application Insights)
4. Auto-scaling configuration
5. Documentation and developer guides

## Key Design Decisions

### 1. **App Routing Strategy**
Each app has its own Azure Web App with unique URL:
- `https://midisocket.azurewebsites.net/`
- `https://countmein.azurewebsites.net/`
- `https://dbass.azurewebsites.net/`
- `https://hootbeat.azurewebsites.net/`

Or use custom domains:
- `https://midisocket.beatlink.app/`
- `https://countmein.beatlink.app/`

BeatLink server at:
- `https://beatlink-server.azurewebsites.net/`
- Or: `https://api.beatlink.app/`

### 2. **App Registration & Discovery**
Apps register themselves on startup:
```javascript
// In each app's startup.js
const registerWithBeatLink = async () => {
  await axios.post('https://beatlink-server.azurewebsites.net/api/apps/register', {
    name: 'midisocket',
    url: 'https://midisocket.azurewebsites.net',
    version: '1.0.0',
    health: '/health',
    capabilities: ['sequencer', 'midi-routing']
  });
};
```

Apps send heartbeats every 30 seconds to maintain registration.

### 3. **Session State Management**
**Distributed State with Redis:**
- All session data stored in Azure Cache for Redis
- Apps read/write session state via `@beatlink/session-manager`
- Session manager automatically syncs with Redis
- Enables session sharing across apps if needed

```javascript
// In app code
const { SessionManager } = require('@beatlink/session-manager');
const sessionManager = new SessionManager({
  redis: process.env.REDIS_URL,
  appName: 'midisocket'
});

// Creates session in Redis
await sessionManager.createSession('session123', config);
```

### 4. **Socket.io Architecture**
Each app runs its own Socket.io server:
- Clients connect directly to app instances
- No central Socket.io server
- Apps can optionally publish events to BeatLink for cross-app coordination

Optional: Use Azure SignalR Service for scaling Socket.io

### 5. **Configuration Management**
**Three-tier configuration:**
1. **App Environment Variables** (Azure Web App settings)
   - `BEATLINK_SERVER_URL` - BeatLink server endpoint
   - `REDIS_URL` - Azure Redis connection string
   - `APP_NAME` - Application identifier
   - App-specific configs (NUM_TRACKS, etc.)

2. **Shared Config from BeatLink Server** (via API)
   - Global settings
   - Feature flags
   - Shared resources

3. **Local Config Files** (in app repo)
   - Default values
   - Development overrides

### 6. **Backward Compatibility**
URLs change but app behavior stays the same:
- Old: `http://myserver.com:3000/sequencer?session=xyz`
- New: `https://midisocket.azurewebsites.net/sequencer?session=xyz`
- Query parameters and socket events unchanged
- Update client code to use new URLs (or use Azure Front Door for unified entry point)

## BeatLink Server API

### App Registration Endpoints

```javascript
// Register app
POST /api/apps/register
Body: {
  name: 'midisocket',
  url: 'https://midisocket.azurewebsites.net',
  version: '1.0.0',
  health: '/health',
  capabilities: ['sequencer', 'midi-routing']
}
Response: { appId: 'uuid', registered: true }

// Heartbeat (keep-alive)
POST /api/apps/:appId/heartbeat
Response: { status: 'ok', timestamp: '...' }

// Unregister app
DELETE /api/apps/:appId
Response: { unregistered: true }

// List all registered apps
GET /api/apps
Response: { apps: [...] }

// Get specific app info
GET /api/apps/:appId
Response: { name, url, version, health, lastHeartbeat, ... }
```

### Session Coordination Endpoints

```javascript
// Create/Update session
POST /api/sessions
Body: {
  appName: 'midisocket',
  sessionName: 'session123',
  data: { participants: [...], config: {...} }
}
Response: { sessionId: 'uuid', created: true }

// Get session state
GET /api/sessions/:sessionId
Response: { sessionId, appName, sessionName, data: {...} }

// Update session attribute
PATCH /api/sessions/:sessionId
Body: { attributes: { key: value } }
Response: { updated: true }

// Delete session
DELETE /api/sessions/:sessionId
Response: { deleted: true }

// List sessions for app
GET /api/sessions?appName=midisocket
Response: { sessions: [...] }
```

### Distributed Session Manager (NPM Package)

```javascript
// @beatlink/session-manager package
class SessionManager {
  constructor(config) {
    this.redis = createRedisClient(config.redis);
    this.appName = config.appName;
    this.beatLinkUrl = config.beatLinkUrl;
  }
  
  // Session lifecycle
  async createSession(name, config) { ... }
  async getSession(name) { ... }
  async deleteSession(name) { ... }
  async listSessions() { ... }
  
  // Participant management
  async allocateParticipant(sessionName, socketID, initials) { ... }
  async releaseParticipant(sessionName, socketID) { ... }
  async getParticipant(sessionName, socketID) { ... }
  
  // Session state
  async setAttribute(sessionName, key, value) { ... }
  async getAttribute(sessionName, key) { ... }
  async updateState(sessionName, updates) { ... }
  
  // Sequencer operations (if needed)
  async updateStep(sessionName, track, event) { ... }
  async getStepNotes(sessionName, step) { ... }
  
  // Real-time sync (optional)
  onSessionUpdate(sessionName, callback) { ... }
  publishEvent(sessionName, event) { ... }
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

## Configuration Examples

### BeatLink Server (Azure Web App Settings)
```bash
# Application Settings in Azure Portal
REDIS_URL=rediss://beatlink.redis.cache.windows.net:6380,password=xxx,ssl=True
NODE_ENV=production
LOG_LEVEL=info
HEARTBEAT_TIMEOUT=60000  # 60 seconds
SESSION_TTL=86400        # 24 hours
```

### Individual App (Azure Web App Settings)
```bash
# Application Settings for midisocket Azure Web App
BEATLINK_SERVER_URL=https://beatlink-server.azurewebsites.net
REDIS_URL=rediss://beatlink.redis.cache.windows.net:6380,password=xxx,ssl=True
APP_NAME=midisocket
APP_VERSION=1.0.0
NUM_TRACKS=16
NUM_STEPS=16
MAX_NUM_ROUNDS=100
NODE_ENV=production
```

### App Startup Code
```javascript
// startup.js in each app
const axios = require('axios');
const { SessionManager } = require('@beatlink/session-manager');

const config = {
  beatLinkUrl: process.env.BEATLINK_SERVER_URL,
  redis: process.env.REDIS_URL,
  appName: process.env.APP_NAME,
  appUrl: process.env.WEBSITE_HOSTNAME ? 
    `https://${process.env.WEBSITE_HOSTNAME}` : 
    'http://localhost:3000'
};

// Initialize session manager
const sessionManager = new SessionManager(config);

// Register with BeatLink
const register = async () => {
  try {
    const response = await axios.post(
      `${config.beatLinkUrl}/api/apps/register`,
      {
        name: config.appName,
        url: config.appUrl,
        version: process.env.APP_VERSION || '1.0.0',
        health: '/health',
        capabilities: ['sequencer', 'midi-routing']
      }
    );
    
    const { appId } = response.data;
    console.log(`Registered with BeatLink as ${appId}`);
    
    // Start heartbeat
    setInterval(async () => {
      await axios.post(
        `${config.beatLinkUrl}/api/apps/${appId}/heartbeat`
      );
    }, 30000);
    
  } catch (error) {
    console.error('Failed to register with BeatLink:', error);
  }
};

module.exports = { sessionManager, register };
```

## Benefits of Distributed Architecture

1. **Independent Deployment**: Deploy/update apps without touching others
2. **Separate Repositories**: Each app team owns their codebase
3. **Horizontal Scaling**: Scale each app independently based on demand
4. **Fault Isolation**: One app crash doesn't affect others
5. **Technology Freedom**: Apps can use different versions/frameworks
6. **Easy Development**: New apps don't require server changes
7. **Azure-Native**: Leverages Azure PaaS services (Web Apps, Redis, Service Bus)
8. **CI/CD Per App**: Each app has its own deployment pipeline
9. **Cost Optimization**: Pay only for resources each app needs
10. **Team Autonomy**: Different teams can own different apps

## Future Enhancements

1. **Multi-tenancy**: Support multiple performances simultaneously
2. **Recording/Playback**: Record sessions for later analysis
3. **Cross-app Communication**: Apps can interact with each other
4. **Plugin System**: Community-contributed app modules
5. **Cloud Storage**: Store sessions, recordings in cloud
6. **Mobile Apps**: Native mobile clients
7. **WebRTC Integration**: Low-latency audio streaming

## Getting Started (Development)

1. Create core infrastructure
2. Migrate simplest app first (dbass)
3. Test thoroughly
4. Migrate next app
5. Iterate until all apps migrated
6. Add enhancements

## Azure Deployment Architecture

### Resource Topology

```
Azure Resource Group: beatlink-platform
├── Azure Cache for Redis (Premium)
│   └── beatlink-redis.redis.cache.windows.net
├── Azure Application Insights
│   └── beatlink-insights
├── Azure Web App (BeatLink Server)
│   ├── Name: beatlink-server
│   ├── URL: beatlink-server.azurewebsites.net
│   └── Plan: Premium P1V2 (Always On enabled)
├── Azure Web App (midisocket)
│   ├── Name: midisocket
│   ├── URL: midisocket.azurewebsites.net
│   └── Plan: Basic B1 or higher
├── Azure Web App (countmein)
│   ├── Name: countmein
│   └── Plan: Basic B1 or higher
├── Azure Web App (dbass)
│   └── Plan: Basic B1 or higher
└── Azure Web App (hootbeat)
    └── Plan: Basic B1 or higher

Optional:
├── Azure Front Door (Unified entry point)
│   ├── Route: *.beatlink.app/* → app instances
│   └── WAF for security
├── Azure Service Bus (Cross-app messaging)
└── Azure Key Vault (Secrets management)
```

### CI/CD Pipeline (GitHub Actions)

**BeatLink Server (.github/workflows/deploy-azure.yml):**
```yaml
name: Deploy BeatLink Server

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
      - run: npm ci
      - run: npm test
      - uses: azure/webapps-deploy@v2
        with:
          app-name: beatlink-server
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

**Individual App (.github/workflows/deploy-azure.yml):**
```yaml
name: Deploy Midisocket

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
      - run: npm ci
      - run: npm test
      - uses: azure/webapps-deploy@v2
        with:
          app-name: midisocket
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

### Scaling Strategy

**BeatLink Server:**
- Scale up: Use Premium tier for high availability
- Always On: Enabled (no cold starts)
- Auto-scale: Based on CPU/Memory metrics

**Individual Apps:**
- Scale out: Multiple instances per app
- Session affinity: Use Azure Application Gateway or Azure Front Door with sticky sessions
- Auto-scale rules based on:
  - Active Socket.io connections
  - CPU usage
  - Memory usage

### Monitoring & Logging

**Azure Application Insights Integration:**
```javascript
// In each app
const appInsights = require('applicationinsights');
appInsights.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
  .setAutoDependencyCorrelation(true)
  .setAutoCollectRequests(true)
  .setAutoCollectPerformance(true)
  .setAutoCollectExceptions(true)
  .setAutoCollectDependencies(true)
  .start();

// Custom telemetry
appInsights.defaultClient.trackEvent({
  name: 'SessionCreated',
  properties: { appName: 'midisocket', sessionName: 'xyz' }
});
```

**Centralized Logging:**
- All apps send logs to Application Insights
- Unified dashboard for cross-app monitoring
- Alerts on errors, performance degradation
- Custom queries with Kusto (KQL)

## Communication Patterns

### 1. Client → App (Direct)
Clients connect directly to app instances via Socket.io:
```javascript
// Client code
const socket = io('https://midisocket.azurewebsites.net', {
  query: { session: 'session123', initials: 'JP' }
});
```

### 2. App → BeatLink Server (REST API)
Apps communicate with BeatLink via HTTP:
```javascript
// In app
const axios = require('axios');
await axios.post(`${BEATLINK_URL}/api/sessions`, sessionData);
```

### 3. App ↔ Redis (Direct)
Apps read/write session state directly to Redis:
```javascript
// Via @beatlink/session-manager
await sessionManager.createSession('session123', config);
```

### 4. Cross-App Communication (Optional)
For apps that need to communicate:

**Option A: Via BeatLink Server**
```javascript
// App publishes event
await axios.post(`${BEATLINK_URL}/api/events`, {
  from: 'midisocket',
  to: 'countmein',
  event: 'session-started',
  data: {...}
});
```

**Option B: Via Azure Service Bus**
```javascript
const { ServiceBusClient } = require('@azure/service-bus');
const sbClient = new ServiceBusClient(connectionString);
const sender = sbClient.createSender('beatlink-events');

await sender.sendMessages({
  body: { from: 'midisocket', event: 'session-started' }
});
```

## Security Considerations

### 1. App Authentication
Apps authenticate with BeatLink using API keys:
```javascript
await axios.post(`${BEATLINK_URL}/api/apps/register`, {
  // ...
}, {
  headers: { 
    'X-API-Key': process.env.BEATLINK_API_KEY 
  }
});
```

### 2. Redis Security
- TLS/SSL enabled (rediss://)
- Network isolation via Azure Private Link
- Access keys stored in Azure Key Vault

### 3. App Communication
- HTTPS only (enforced by Azure Web Apps)
- CORS configured per app
- Socket.io authentication tokens

### 4. Azure Front Door (Optional)
- Web Application Firewall (WAF)
- DDoS protection
- Rate limiting
- Custom domains with SSL

## Cost Optimization

### Estimated Monthly Costs (Azure Pricing)

**Core Infrastructure:**
- Azure Cache for Redis (Basic C1): ~$17/month
- BeatLink Server (Premium P1V2): ~$70/month

**Per App Instance:**
- Basic B1 (1 core, 1.75GB RAM): ~$13/month
- Or Standard S1 (for auto-scale): ~$70/month

**Example Total (4 apps):**
- Redis: $17
- BeatLink Server: $70
- 4 Apps × $13: $52
- **Total: ~$139/month**

**Cost Saving Tips:**
- Use Free tier Redis for development
- Share App Service Plans across apps
- Use consumption-based pricing for low-traffic apps
- Implement auto-scale down during off-hours

## Development Workflow

### Creating a New App

1. **Create repository:**
```bash
git clone https://github.com/yourorg/app-template
cd app-template
npm install
```

2. **Configure app:**
```javascript
// config.js
module.exports = {
  appName: 'my-new-app',
  beatLinkUrl: process.env.BEATLINK_SERVER_URL,
  redis: process.env.REDIS_URL,
  // App-specific config
  numTracks: 8,
  numSteps: 16
};
```

3. **Implement app logic:**
```javascript
// index.js
const express = require('express');
const { SessionManager } = require('@beatlink/session-manager');
const { register } = require('./startup');

const app = express();
const sessionManager = new SessionManager(config);

// Your routes and socket handlers
// ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await register(); // Register with BeatLink
  console.log(`App running on ${PORT}`);
});
```

4. **Deploy to Azure:**
```bash
# Create Azure Web App
az webapp create \
  --name my-new-app \
  --resource-group beatlink-platform \
  --plan beatlink-plan

# Set environment variables
az webapp config appsettings set \
  --name my-new-app \
  --settings BEATLINK_SERVER_URL=https://... REDIS_URL=...

# Deploy
git push azure main
```

5. **Done!** App automatically registers with BeatLink on startup.

### Local Development

**Run BeatLink Server locally:**
```bash
cd beatlink
npm install
docker run -p 6379:6379 redis:alpine  # Local Redis
export REDIS_URL=redis://localhost:6379
npm start
```

**Run individual app locally:**
```bash
cd app-midisocket
npm install
export BEATLINK_SERVER_URL=http://localhost:4000
export REDIS_URL=redis://localhost:6379
export APP_NAME=midisocket
npm start
```

**Test with ngrok for Socket.io:**
```bash
ngrok http 3000
# Use ngrok URL in client code for testing
```

## Migration Path from Current Setup

### Step-by-Step Migration

**Week 1-2: Infrastructure Setup**
1. Create Azure resource group
2. Provision Redis cache
3. Create shared packages repository
4. Extract sessionObj.js to `@beatlink/session-manager`
5. Publish package

**Week 3-4: BeatLink Server**
1. Create beatlink server repository
2. Implement app registry API
3. Implement session coordination API
4. Deploy to Azure Web App
5. Test registration and session APIs

**Week 5: First App Migration (dbass - simplest)**
1. Create `app-dbass` repository
2. Copy existing dbass code
3. Install `@beatlink/session-manager`
4. Update to use distributed sessions
5. Add registration logic
6. Test locally with BeatLink server
7. Deploy to Azure Web App
8. Update client URLs
9. Test end-to-end

**Week 6-8: Remaining Apps**
1. Migrate count-me-in
2. Migrate midisocket
3. Migrate hootbeat
4. Each follows same process as dbass

**Week 9-10: Production Cutover**
1. Load testing
2. Performance optimization
3. Monitoring setup
4. DNS updates
5. Gradual traffic migration
6. Monitor and fix issues

## Notes

- Keep midisocket sessionObj.js as the base (newest, most complete)
- Support both sequencer and non-sequencer modes
- Maintain flexible attribute system for app-specific data
- Logging should include app name for easy filtering
- Use Azure Application Insights for unified monitoring
- Consider Azure SignalR Service if Socket.io scaling becomes an issue
- Implement retry logic for Redis and BeatLink API calls
- Use health checks to detect app failures quickly
