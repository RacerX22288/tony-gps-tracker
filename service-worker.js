// Tony's GPS Tracker - Service Worker
// Handles background GPS tracking and Firebase sync

const CACHE_NAME = 'tony-gps-v1';
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBJaTKBMZm26Cc0OoI1jqImq2L_4SeugbU",
  authDomain: "trail-map-30113.firebaseapp.com",
  databaseURL: "https://trail-map-30113-default-rtdb.firebaseio.com",
  projectId: "trail-map-30113",
  storageBucket: "trail-map-30113.appspot.com",
  messagingSenderId: "573419392500",
  appId: "1:573419392500:web:c2c0cb3c3cb40742537da1"
};

// State
let tracking = false;
let activeTripId = null;
let trackingMode = 'smart';
let trackingInterval = null;
let trackingConfig = {
  cornerAngle: 12,
  straightDist: 15.0,
  minMove: 0.05
};
let lastSavedFix = null;
let pointCount = 0;

// ====================================
// INSTALL & ACTIVATE
// ====================================

self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activated');
  event.waitUntil(clients.claim());
});

// ====================================
// MESSAGE HANDLING FROM MAIN APP
// ====================================

self.addEventListener('message', (event) => {
  const { action, data } = event;
  
  console.log('SW received message:', action);
  
  switch(action) {
    case 'START_TRACKING':
      startTracking(event.data);
      break;
    case 'STOP_TRACKING':
      stopTracking();
      break;
    case 'GPS_POSITION':
      handleGPSPosition(event.data);
      break;
  }
});

// ====================================
// BACKGROUND TRACKING LOGIC
// ====================================

function startTracking(config) {
  console.log('SW: Starting tracking with config:', config);
  
  tracking = true;
  activeTripId = config.tripId;
  trackingMode = config.mode;
  trackingConfig = config.config || trackingConfig;
  pointCount = 0;
  
  if (config.interval) {
    trackingInterval = config.interval;
  }
  
  // Show persistent notification
  self.registration.showNotification('Tony GPS Tracker', {
    body: 'Background tracking is active',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'gps-tracking',
    requireInteraction: false,
    silent: true
  });
}

function stopTracking() {
  console.log('SW: Stopping tracking');
  tracking = false;
  activeTripId = null;
  lastSavedFix = null;
  
  // Close notification
  self.registration.getNotifications({ tag: 'gps-tracking' })
    .then(notifications => {
      notifications.forEach(notification => notification.close());
    });
}

function handleGPSPosition(position) {
  if (!tracking) return;
  
  console.log('SW: Processing GPS position');
  
  const currentFix = {
    lat: position.lat,
    lng: position.lng,
    head: position.head,
    speed: position.speed,
    ts: position.ts
  };
  
  // First point always saves
  if (!lastSavedFix) {
    savePointToFirebase(currentFix, 'gps');
    return;
  }
  
  // Decide if we should save based on mode
  let shouldSave = false;
  const distMiles = getDistMiles(lastSavedFix, currentFix);
  
  if (trackingMode === 'smart') {
    const headDelta = Math.abs(getAngleDiff(lastSavedFix.head, currentFix.head));
    if (distMiles > 0.02 && headDelta > trackingConfig.cornerAngle) {
      shouldSave = true;
    } else if (distMiles > trackingConfig.straightDist) {
      shouldSave = true;
    }
    
    // Don't save if barely moved
    if (shouldSave && distMiles < trackingConfig.minMove) {
      shouldSave = false;
    }
  } else if (trackingMode === 'dist') {
    if (distMiles >= parseFloat(trackingInterval)) shouldSave = true;
  } else if (trackingMode === 'time') {
    if (Date.now() - lastSavedFix.ts >= parseInt(trackingInterval)) shouldSave = true;
  }
  
  if (shouldSave) {
    savePointToFirebase(currentFix, 'gps');
  }
  
  // Send update to main app
  sendMessageToClients({
    type: 'GPS_UPDATE',
    speed: position.speed,
    heading: position.head,
    pointCount: pointCount
  });
}

// ====================================
// FIREBASE OPERATIONS
// ====================================

async function savePointToFirebase(fix, source) {
  if (!activeTripId) return;
  
  const data = {
    lat: fix.lat,
    lng: fix.lng,
    ts: fix.ts || Date.now(),
    source: source,
    tripId: activeTripId,
    color: null,
    note: null
  };
  
  try {
    // Save to global points
    await firebasePush(`sessions/TONYLIVE/points`, data);
    
    // Save to trip points
    await firebasePush(`sessions/TONYLIVE/trips/${activeTripId}/points`, data);
    
    lastSavedFix = fix;
    pointCount++;
    
    console.log('SW: Point saved to Firebase, total:', pointCount);
    
    // Update notification
    self.registration.showNotification('Tony GPS Tracker', {
      body: `Tracking: ${pointCount} points recorded`,
      icon: '/icon-192.png',
      tag: 'gps-tracking',
      requireInteraction: false,
      silent: true
    });
    
  } catch (error) {
    console.error('SW: Firebase save error:', error);
  }
}

async function firebasePush(path, data) {
  const url = `${FIREBASE_CONFIG.databaseURL}/${path}.json`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    throw new Error(`Firebase push failed: ${response.status}`);
  }
  
  return response.json();
}

// ====================================
// UTILITY FUNCTIONS
// ====================================

function getDistMiles(p1, p2) {
  if (!p1 || !p2) return 0;
  const R = 3958.8;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
            Math.cos(p1.lat * Math.PI / 180) * 
            Math.cos(p2.lat * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * R;
}

function getAngleDiff(a1, a2) {
  let diff = (a2 - a1 + 180) % 360 - 180;
  return diff < -180 ? diff + 360 : diff;
}

function sendMessageToClients(message) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage(message);
    });
  });
}

// ====================================
// BACKGROUND FETCH (FOR OFFLINE SUPPORT)
// ====================================

self.addEventListener('fetch', (event) => {
  // Let Firebase requests pass through
  if (event.request.url.includes('firebaseio.com')) {
    return;
  }
  
  // Cache-first strategy for app resources
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

// ====================================
// PERIODIC BACKGROUND SYNC (Optional)
// ====================================

// This will attempt to keep tracking alive even if page is fully closed
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'gps-tracking') {
    event.waitUntil(checkTrackingStatus());
  }
});

async function checkTrackingStatus() {
  if (tracking) {
    console.log('SW: Periodic sync - tracking still active');
    // Could request a GPS position here if we had background geolocation API
    // For now, this just keeps the service worker alive
  }
}
