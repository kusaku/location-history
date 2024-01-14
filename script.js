// Theme Switcher
const getSystemPreference = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

const applyTheme = () => {
    const theme = localStorage.theme ?? 'system';
    const isDark = theme === 'system' ? getSystemPreference() : theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    updateThemeButtons(theme);
};

const updateThemeButtons = (theme = 'system') => {
    const buttons = {
        system: document.getElementById('theme-system'),
        light: document.getElementById('theme-light'),
        dark: document.getElementById('theme-dark')
    };
    
    Object.entries(buttons).forEach(([key, btn]) => {
        if (!btn) return;
        const isActive = key === theme;
        btn.classList.toggle('bg-indigo-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('text-gray-700', !isActive);
        btn.classList.toggle('hover:bg-gray-100', !isActive);
    });
};

const setTheme = (theme) => {
    theme === 'system' ? localStorage.removeItem('theme') : localStorage.theme = theme;
    applyTheme();
};

const initTheme = () => {
    applyTheme();
    document.getElementById('theme-system')?.addEventListener('click', () => setTheme('system'));
    document.getElementById('theme-light')?.addEventListener('click', () => setTheme('light'));
    document.getElementById('theme-dark')?.addEventListener('click', () => setTheme('dark'));
    
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (!localStorage.theme || localStorage.theme === 'system') applyTheme();
    });
};

// Main Application
const filesInput = document.getElementById('historyFile');
const message = document.getElementById('message');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
let selectedTileStyle = 'satellite';
const startHandle = document.getElementById('startHandle');
const endHandle = document.getElementById('endHandle');
const dualRangeTrack = document.getElementById('dualRangeTrack');
const dualRangeFill = document.getElementById('dualRangeFill');
const startDateLabel = document.getElementById('startDateLabel');
const endDateLabel = document.getElementById('endDateLabel');

const map = L.map('map').setView([20, 0], 2);

let tileLayer;
let heatLayer;
let pointsHistory = new Map();
let points = [];
// Initialize with default range (1 day) so widget works without CSS manipulation
let minTimestamp = 0;
let maxTimestamp = 86400000; // 1 day in milliseconds
let startValue = 0;
let endValue = 86400000;
let activeHandle = null;
let isDragging = false;
let isUpdatingMap = false;
let keyboardInterval = null;
let keyboardAcceleration = 0;
let keyboardDirection = null;
let debounceTimeout = null;

const selectMapStyle = (style) => {
    selectedTileStyle = style;
    document.querySelectorAll('.map-style-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-tile="${style}"]`)?.classList.add('active');
    drawMap();
};

const drawMap = () => {
    const tileUrls = {
        satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'osm-bike': 'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png',
        'esri-topo': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        'esri-streets': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
        'carto-dark': 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        'carto-light': 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'opentopo': 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'
    };
    const tileUrl = tileUrls[selectedTileStyle] ?? tileUrls['satellite'];

    tileLayer?.remove();
    heatLayer?.remove();

    // Handle subdomains for tile providers that use them
    const subdomainProviders = ['osm-bike', 'carto-dark', 'carto-light', 'opentopo'];
    if (subdomainProviders.includes(selectedTileStyle)) {
        tileLayer = L.tileLayer(tileUrl, {
            subdomains: 'abc',
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    } else {
        tileLayer = L.tileLayer(tileUrl).addTo(map);
    }
    const isLargeDataset = points.length > 100000;
    heatLayer = L.heatLayer(points, {
        max: 0.0000001,
        radius: isLargeDataset ? 3 : 2,
        blur: isLargeDataset ? 3 : 2,
        maxZoom: 17,
        gradient: { 0.0: 'blue', 0.5: 'cyan', 0.7: 'lime', 0.9: 'yellow', 1.0: 'red' }
    }).addTo(map);
};

drawMap();

const getValueFromPosition = (x) => {
    const rect = dualRangeTrack.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    return minTimestamp + percentage * (maxTimestamp - minTimestamp);
};

const getPositionFromValue = (value) => {
    if (maxTimestamp === minTimestamp) return 0;
    return ((value - minTimestamp) / (maxTimestamp - minTimestamp)) * 100;
};

const formatDateTime = (timestamp) => {
    if (!timestamp || timestamp === 0 || !isFinite(timestamp)) return '--';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '--';
    return date.toLocaleString('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replace(',', '');
};

const updateHandleValue = (isStart, newValue) => {
    if (isStart) {
        startValue = Math.max(minTimestamp, Math.min(newValue, endValue - 1));
    } else {
        endValue = Math.min(maxTimestamp, Math.max(newValue, startValue + 1));
    }
};

const updateDualRange = () => {
    const startPercent = getPositionFromValue(startValue);
    const endPercent = getPositionFromValue(endValue);
    const [leftPercent, rightPercent] = [Math.min(startPercent, endPercent), Math.max(startPercent, endPercent)];
    
    startHandle.style.left = `${startPercent}%`;
    endHandle.style.left = `${endPercent}%`;
    dualRangeFill.style.left = `${leftPercent}%`;
    dualRangeFill.style.width = `${rightPercent - leftPercent}%`;
    
    // Show "--" when no real data is loaded
    if (pointsHistory.size === 0) {
        startDateLabel.textContent = '--';
        endDateLabel.textContent = '--';
        message.textContent = '';
    } else {
        const [startDateTime, endDateTime] = [formatDateTime(startValue), formatDateTime(endValue)];
        startDateLabel.textContent = startDateTime;
        endDateLabel.textContent = endDateTime;
        const filteredCount = Array.from(pointsHistory.keys())
            .filter(timestamp => timestamp >= startValue && timestamp <= endValue).length;
        message.textContent = `${filteredCount.toLocaleString()} / ${pointsHistory.size.toLocaleString()} points • ${startDateTime} - ${endDateTime}`;
    }
    
    updateAriaAttributes();
};

const getClientX = (e) => e.clientX ?? e.touches?.[0]?.clientX ?? 0;

const handleStart = (e, handle) => {
    if (pointsHistory.size === 0) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    activeHandle = handle;
    handle.style.cursor = 'grabbing';
    handle.focus();
};

const handleMove = (e) => {
    if (!isDragging || !activeHandle) return;
    e.preventDefault();
    const isStart = activeHandle === startHandle;
    updateHandleValue(isStart, getValueFromPosition(getClientX(e)));
    updateDualRange();
    drawPoints();
};

const handleEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    if (activeHandle) {
        activeHandle.style.cursor = 'grab';
        activeHandle.focus();
    }
    activeHandle = null;
    drawPoints(true);
};

const handleTrackClick = (e) => {
    if (isDragging || pointsHistory.size === 0) return;
    const clickValue = getValueFromPosition(getClientX(e));
    const isStart = Math.abs(clickValue - startValue) < Math.abs(clickValue - endValue);
    updateHandleValue(isStart, clickValue);
    updateDualRange();
    drawPoints(true);
};

const moveHandle = (handle, direction) => {
    if (pointsHistory.size === 0) return;
    const isStart = handle === startHandle;
    const step = 3600000 * Math.min(1 + keyboardAcceleration * 0.15, 8) * direction;
    const currentValue = isStart ? startValue : endValue;
    updateHandleValue(isStart, currentValue + step);
    updateDualRange();
    drawPoints();
};

const handleKeyboardDown = (e, handle) => {
    if (pointsHistory.size === 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    
    if (keyboardInterval && keyboardDirection === e.key) return;
    
    if (keyboardInterval) clearInterval(keyboardInterval);
    
    keyboardDirection = e.key;
    keyboardAcceleration = 0;
    const direction = e.key === 'ArrowLeft' ? -1 : 1;
    
    moveHandle(handle, direction);
    
    keyboardInterval = setInterval(() => {
        keyboardAcceleration++;
        moveHandle(handle, direction);
    }, 100);
};

const handleKeyboardUp = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (keyboardInterval) {
            clearInterval(keyboardInterval);
            keyboardInterval = null;
        }
        keyboardAcceleration = 0;
        keyboardDirection = null;
        drawPoints(true); // Immediate update when key is released
    }
};

const updateAriaAttributes = () => {
    [startHandle, endHandle].forEach((handle, i) => {
        const value = i === 0 ? startValue : endValue;
        handle.setAttribute('aria-valuemin', minTimestamp);
        handle.setAttribute('aria-valuemax', maxTimestamp);
        handle.setAttribute('aria-valuenow', value);
    });
};

// Initialize dual range slider event listeners using Pointer Events API (unifies mouse/touch)
startHandle.addEventListener('pointerdown', (e) => handleStart(e, startHandle));
endHandle.addEventListener('pointerdown', (e) => handleStart(e, endHandle));
startHandle.addEventListener('click', (e) => {
    e.stopPropagation();
    startHandle.focus();
});
endHandle.addEventListener('click', (e) => {
    e.stopPropagation();
    endHandle.focus();
});
startHandle.addEventListener('keydown', (e) => handleKeyboardDown(e, startHandle));
startHandle.addEventListener('keyup', handleKeyboardUp);
endHandle.addEventListener('keydown', (e) => handleKeyboardDown(e, endHandle));
endHandle.addEventListener('keyup', handleKeyboardUp);
// Also handle keyup on document in case focus is lost
document.addEventListener('keyup', handleKeyboardUp);
dualRangeTrack.addEventListener('click', handleTrackClick);
document.addEventListener('pointermove', handleMove);
document.addEventListener('pointerup', handleEnd);
document.addEventListener('pointercancel', handleEnd);

const parseJson = async () => {
    if (!filesInput.files.length) {
        message.textContent = '';
        progressContainer.classList.add('hidden');
        return;
    }
    
    pointsHistory = new Map();
    minTimestamp = Infinity; // Reset to find actual min from file
    maxTimestamp = -Infinity; // Reset to find actual max from file
    const fileCount = filesInput.files.length;
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    message.textContent = fileCount > 1 ? `Loading ${fileCount} files...` : 'Loading...';

    let loadedCount = 0;
    const totalBytes = Array.from(filesInput.files).reduce((sum, file) => sum + file.size, 0);
    let loadedBytes = 0;

    const processFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onprogress = (e) => {
            if (e.lengthComputable) {
                const overallProgress = ((loadedBytes + e.loaded) / totalBytes) * 100;
                progressFill.style.width = `${overallProgress}%`;
            }
        };
        
        reader.onload = async (e) => {
            try {
                loadedBytes += file.size;
                const data = JSON.parse(e.target.result);
                const locations = data.locations ?? [];
                
                const processBatch = (batch) => {
                    for (const entry of batch) {
                        if (!('latitudeE7' in entry && 'longitudeE7' in entry && 'timestamp' in entry)) continue;
                        
                        const timestamp = new Date(entry.timestamp).getTime();
                        const coords = [entry.latitudeE7 / 10e6, entry.longitudeE7 / 10e6];
                        minTimestamp = Math.min(minTimestamp, timestamp);
                        maxTimestamp = Math.max(maxTimestamp, timestamp);
                        pointsHistory.set(timestamp, coords);
                    }
                };
                
                const batchSize = 10000;
                for (let i = 0; i < locations.length; i += batchSize) {
                    const batch = locations.slice(i, i + batchSize);
                    await new Promise(resolve => {
                        requestAnimationFrame(() => {
                            processBatch(batch);
                            const parseProgress = ((i + batch.length) / locations.length) * 100;
                            const overallProgress = ((loadedBytes - file.size + (file.size * parseProgress / 100)) / totalBytes) * 100;
                            progressFill.style.width = `${overallProgress}%`;
                            setTimeout(resolve, 0);
                        });
                    });
                }
                
                loadedCount++;
                if (loadedCount === fileCount) {
                    progressFill.style.width = '100%';
                    setTimeout(() => {
                        progressContainer.classList.add('hidden');
                        // If no valid data loaded, reset to default range
                        if (minTimestamp === Infinity || maxTimestamp === -Infinity) {
                            minTimestamp = 0;
                            maxTimestamp = 86400000;
                        }
                        startValue = minTimestamp;
                        endValue = maxTimestamp;
                        updateDualRange();
                        updateAriaAttributes();
                        fitMapToPoints();
                        drawPoints();
                    }, 100);
                } else {
                    message.textContent = `Loaded ${loadedCount}/${fileCount} files...`;
                }
                resolve();
            } catch (error) {
                message.textContent = `Error loading ${file.name}`;
                progressContainer.classList.add('hidden');
                reject(error);
            }
        };
        
        reader.onerror = () => {
            message.textContent = `Error reading ${file.name}`;
            progressContainer.classList.add('hidden');
            reject(new Error(`Failed to read ${file.name}`));
        };
        
        reader.readAsText(file);
    });
    
    await Promise.all(Array.from(filesInput.files).map(processFile));
};

// Update file button text when files are selected
filesInput.addEventListener('change', () => {
    if (filesInput.files.length > 0) {
        const button = document.querySelector('.file-input-button span');
        if (button) {
            const fileCount = filesInput.files.length;
            button.textContent = fileCount > 1 ? `${fileCount} files selected` : filesInput.files[0].name;
        }
    }
});

const calculateGeometricCenter = (points) => {
    if (!points.length) return null;
    const sum = points.reduce((acc, [lat, lng]) => [acc[0] + lat, acc[1] + lng], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
};

const calculateDistanceSquared = (p1, p2) => {
    const dLat = p2[0] - p1[0];
    const dLng = p2[1] - p1[1];
    return dLat * dLat + dLng * dLng;
};

const quickselect = (arr, k, left = 0, right = arr.length - 1) => {
    if (left === right) return arr[left];
    
    const pivotIndex = partition(arr, left, right, Math.floor((left + right) / 2));
    if (k === pivotIndex) return arr[k];
    return k < pivotIndex 
        ? quickselect(arr, k, left, pivotIndex - 1)
        : quickselect(arr, k, pivotIndex + 1, right);
};

const partition = (arr, left, right, pivotIndex) => {
    const pivotValue = arr[pivotIndex];
    [arr[pivotIndex], arr[right]] = [arr[right], arr[pivotIndex]];
    let storeIndex = left;
    
    for (let i = left; i < right; i++) {
        if (arr[i] < pivotValue) {
            [arr[storeIndex], arr[i]] = [arr[i], arr[storeIndex]];
            storeIndex++;
        }
    }
    [arr[right], arr[storeIndex]] = [arr[storeIndex], arr[right]];
    return storeIndex;
};

const fitMapToPoints = () => {
    if (pointsHistory.size === 0) return;
    
    const allPoints = Array.from(pointsHistory.values());
    const center = calculateGeometricCenter(allPoints);
    if (!center) return;
    
    // Calculate squared distances (faster, preserves ordering for percentile)
    const distancesSquared = allPoints.map(point => calculateDistanceSquared(center, point));
    
    // Use quickselect to find median without full sort (O(n) vs O(n log n))
    const medianIndex = Math.floor(distancesSquared.length / 2);
    const medianDistanceSquared = quickselect([...distancesSquared], medianIndex);
    
    // Calculate bounding box in single pass, filtering by median distance
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    let hasPoints = false;
    
    for (const [lat, lng] of allPoints) {
        if (calculateDistanceSquared(center, [lat, lng]) <= medianDistanceSquared) {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            hasPoints = true;
        }
    }
    
    // Fallback to all points if none within median
    if (!hasPoints) {
        for (const [lat, lng] of allPoints) {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
        }
    }
    
    const southWest = L.latLng(minLat, minLng);
    const northEast = L.latLng(maxLat, maxLng);
    const bounds = new L.LatLngBounds(southWest, northEast);
    map.fitBounds(bounds);
};

const drawPoints = (immediate = false) => {
    if (isUpdatingMap) return;
    
    const performFilter = () => {
        isUpdatingMap = true;
        requestAnimationFrame(() => {
            points = Array.from(pointsHistory.entries())
                .filter(([timestamp]) => timestamp >= startValue && timestamp <= endValue)
                .map(([, coords]) => coords);
            
            heatLayer?.setLatLngs(points.length ? points : []);
            isUpdatingMap = false;
        });
    };
    
    if (immediate) {
        performFilter();
    } else {
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(performFilter, 300);
    }
};

// About Modal Functions
const toggleAbout = () => {
    const modal = document.getElementById('about-modal');
    if (modal) {
        modal.classList.toggle('hidden');
        document.body.style.overflow = modal.classList.contains('hidden') ? '' : 'hidden';
    }
};

const closeAbout = () => {
    const modal = document.getElementById('about-modal');
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
};

// Initialize theme switcher and dual range slider
const init = () => {
    initTheme();
    updateDualRange();
    document.getElementById('about-toggle')?.addEventListener('click', toggleAbout);
    document.getElementById('about-close')?.addEventListener('click', closeAbout);
};
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();

