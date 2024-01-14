
// Main Application Object
const LocationHistoryApp = {
    // ============================================
    // PROPERTIES & STATE
    // ============================================
    
    // DOM Elements
    elements: {
        filesInput: null,
        message: null,
        progressContainer: null,
        progressFill: null,
        startHandle: null,
        endHandle: null,
        dualRangeTrack: null,
        dualRangeFill: null,
        startDateLabel: null,
        endDateLabel: null,
        radiusSlider: null,
        blurSlider: null,
        radiusValue: null,
        blurValue: null,
        aboutToggle: null,
        aboutModal: null,
        aboutClose: null,
        themeSystem: null,
        themeLight: null,
        themeDark: null
    },
    
    // Map and Layers
    map: null,
    tileLayer: null,
    heatLayer: null,
    
    // Data
    pointsHistory: new Map(),
    points: [],
    
    // Settings
    selectedTileStyle: 'satellite',
    selectedGradient: 'spectrum',
    heatmapRadius: 2,
    heatmapBlur: 2,
    
    // Date Range
    minTimestamp: 0,
    maxTimestamp: 86400000,
    startValue: 0,
    endValue: 86400000,
    
    // Slider State
    activeHandle: null,
    isDragging: false,
    isUpdatingMap: false,
    keyboardInterval: null,
    keyboardAcceleration: 0,
    keyboardDirection: null,
    debounceTimeout: null,
    
    // Constants
    gradients: {
        'spectrum': { 0.0: 'blue', 0.5: 'cyan', 0.7: 'lime', 0.9: 'yellow', 1.0: 'red' },
        'fire': { 0.0: 'black', 0.5: 'maroon', 0.7: 'red', 0.9: 'orange', 1.0: 'white' },
        'cool': { 0.0: 'midnightblue', 0.5: 'blue', 0.7: 'dodgerblue', 0.9: 'skyblue', 1.0: 'white' },
        'grass': { 0.0: 'darkgreen', 0.5: 'green', 0.7: 'limegreen', 0.9: 'lightgreen', 1.0: 'white' },
        'dark': { 0.0: 'silver', 0.5: 'gray', 0.7: 'slategray', 0.9: 'darkslategray', 1.0: 'black' }
    },
    
    tileUrls: {
        'satellite': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        'osm': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'osm-bike': 'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png',
        'esri-topo': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        'esri-streets': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
        'carto-dark': 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        'carto-light': 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'opentopo': 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'
    },
    
    // ============================================
    // INITIALIZATION
    // ============================================
    
    initElements() {
        const ids = {
            filesInput: 'historyFile',
            message: 'message',
            progressContainer: 'progressContainer',
            progressFill: 'progressFill',
            startHandle: 'startHandle',
            endHandle: 'endHandle',
            dualRangeTrack: 'dualRangeTrack',
            dualRangeFill: 'dualRangeFill',
            startDateLabel: 'startDateLabel',
            endDateLabel: 'endDateLabel',
            radiusSlider: 'radiusSlider',
            blurSlider: 'blurSlider',
            radiusValue: 'radiusValue',
            blurValue: 'blurValue',
            aboutToggle: 'aboutToggle',
            aboutModal: 'aboutModal',
            aboutClose: 'aboutClose',
            themeSystem: 'themeSystem',
            themeLight: 'themeLight',
            themeDark: 'themeDark'
        };
        
        for (const [key, id] of Object.entries(ids)) {
            this.elements[key] = document.getElementById(id);
        }
    },
    
    initMap() {
        this.map = L.map('map').setView([20, 0], 2);
        this.drawMap();
    },
    
    initEventListeners() {
        // File input
        this.elements.filesInput?.addEventListener('change', () => this.parseJson());
        
        // Map style buttons
        document.querySelectorAll('.map-style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const style = btn.getAttribute('data-tile');
                if (style) this.selectMapStyle(style);
            });
        });
        
        // Gradient buttons
        document.querySelectorAll('.gradient-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const gradient = btn.getAttribute('data-gradient');
                if (gradient) this.selectGradient(gradient);
            });
        });
        
        // Dual range slider
        this.elements.startHandle.addEventListener('pointerdown', (e) => this.handleStart(e, this.elements.startHandle));
        this.elements.endHandle.addEventListener('pointerdown', (e) => this.handleStart(e, this.elements.endHandle));
        this.elements.startHandle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.elements.startHandle.focus();
        });
        this.elements.endHandle.addEventListener('click', (e) => {
            e.stopPropagation();
            this.elements.endHandle.focus();
        });
        this.elements.startHandle.addEventListener('keydown', (e) => this.handleKeyboardDown(e, this.elements.startHandle));
        this.elements.endHandle.addEventListener('keydown', (e) => this.handleKeyboardDown(e, this.elements.endHandle));
        document.addEventListener('keyup', (e) => this.handleKeyboardUp(e));
        this.elements.dualRangeTrack.addEventListener('click', (e) => this.handleTrackClick(e));
        document.addEventListener('pointermove', (e) => this.handleMove(e));
        document.addEventListener('pointerup', () => this.handleEnd());
        document.addEventListener('pointercancel', () => this.handleEnd());
        
        // Heatmap controls
        const setupSlider = (slider, updateFn) => {
            if (!slider) return;
            slider.addEventListener('input', (e) => updateFn(e.target.value));
            slider.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const step = parseFloat(slider.step) || 0.5;
                    const direction = e.key === 'ArrowLeft' ? -1 : 1;
                    updateFn(parseFloat(slider.value) + (step * direction));
                }
            });
        };
        
        setupSlider(this.elements.radiusSlider, (v) => this.updateRadius(v));
        setupSlider(this.elements.blurSlider, (v) => this.updateBlur(v));
        
        // About modal
        const closeModal = () => {
            if (this.elements.aboutModal) {
                this.elements.aboutModal.classList.add('hidden');
                document.body.style.overflow = '';
            }
        };
        
        this.elements.aboutToggle?.addEventListener('click', () => {
            if (this.elements.aboutModal) {
                this.elements.aboutModal.classList.toggle('hidden');
                document.body.style.overflow = this.elements.aboutModal.classList.contains('hidden') ? '' : 'hidden';
            }
        });
        this.elements.aboutClose?.addEventListener('click', closeModal);
        this.elements.aboutModal?.addEventListener('click', (e) => {
            if (e.target === this.elements.aboutModal) closeModal();
        });
        const modalContent = this.elements.aboutModal?.querySelector('.bg-white');
        modalContent?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    },
    
    initTheme() {
        this.applyTheme();
        this.elements.themeSystem?.addEventListener('click', () => this.setTheme('system'));
        this.elements.themeLight?.addEventListener('click', () => this.setTheme('light'));
        this.elements.themeDark?.addEventListener('click', () => this.setTheme('dark'));
        
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (!localStorage.theme || localStorage.theme === 'system') this.applyTheme();
        });
    },
    
    init() {
        this.initElements();
        this.initMap();
        this.updateDualRange();
        this.initEventListeners();
        this.initTheme();
        this.loadDefaultHistory();
    },
    
    // ============================================
    // MAP & VISUALIZATION
    // ============================================
    
    selectButtonGroup(selector, attribute, value) {
        const buttons = document.querySelectorAll(selector);
        buttons.forEach(btn => btn.classList.remove('active'));
        const activeBtn = Array.from(buttons).find(btn => btn.getAttribute(attribute) === value);
        activeBtn?.classList.add('active');
    },
    
    selectMapStyle(style) {
        this.selectedTileStyle = style;
        this.selectButtonGroup('.map-style-btn', 'data-tile', style);
        this.drawMap();
    },
    
    selectGradient(gradient) {
        this.selectedGradient = gradient;
        this.selectButtonGroup('.gradient-btn', 'data-gradient', gradient);
        this.drawMap();
    },
    
    drawMap() {
        const tileUrl = this.tileUrls[this.selectedTileStyle] ?? this.tileUrls['satellite'];
        
        this.tileLayer?.remove();
        this.heatLayer?.remove();
        
        // Handle subdomains for tile providers that use them
        const subdomainProviders = ['osm-bike', 'carto-dark', 'carto-light', 'opentopo'];
        if (subdomainProviders.includes(this.selectedTileStyle)) {
            this.tileLayer = L.tileLayer(tileUrl, {
                subdomains: 'abc',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            }).addTo(this.map);
        } else {
            this.tileLayer = L.tileLayer(tileUrl).addTo(this.map);
        }
        
        this.heatLayer = L.heatLayer(this.points, {
            max: 0.0000001,
            radius: this.heatmapRadius,
            blur: this.heatmapBlur,
            maxZoom: 17,
            gradient: this.gradients[this.selectedGradient] ?? this.gradients['spectrum']
        }).addTo(this.map);
    },
    
    drawPoints(immediate = false) {
        if (this.isUpdatingMap) return;
        
        const performFilter = () => {
            this.isUpdatingMap = true;
            requestAnimationFrame(() => {
                this.points = [];
                for (const [timestamp, coords] of this.pointsHistory.entries()) {
                    if (timestamp >= this.startValue && timestamp <= this.endValue) {
                        this.points.push(coords);
                    }
                }
                
                this.heatLayer?.setLatLngs(this.points.length ? this.points : []);
                this.isUpdatingMap = false;
            });
        };
        
        if (immediate) {
            performFilter();
        } else {
            if (this.debounceTimeout) clearTimeout(this.debounceTimeout);
            this.debounceTimeout = setTimeout(performFilter, 300);
        }
    },
    
    // ============================================
    // DATE RANGE SLIDER
    // ============================================
    
    getValueFromPosition(x) {
        const rect = this.elements.dualRangeTrack.getBoundingClientRect();
        const percentage = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
        return this.minTimestamp + percentage * (this.maxTimestamp - this.minTimestamp);
    },
    
    getPositionFromValue(value) {
        if (this.maxTimestamp === this.minTimestamp) return 0;
        return ((value - this.minTimestamp) / (this.maxTimestamp - this.minTimestamp)) * 100;
    },
    
    formatDateTime(timestamp) {
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
    },
    
    updateHandleValue(isStart, newValue) {
        if (isStart) {
            this.startValue = Math.max(this.minTimestamp, Math.min(newValue, this.endValue - 1));
        } else {
            this.endValue = Math.min(this.maxTimestamp, Math.max(newValue, this.startValue + 1));
        }
    },
    
    updateDualRange() {
        const startPercent = this.getPositionFromValue(this.startValue);
        const endPercent = this.getPositionFromValue(this.endValue);
        const [leftPercent, rightPercent] = [Math.min(startPercent, endPercent), Math.max(startPercent, endPercent)];
        
        this.elements.startHandle.style.left = `${startPercent}%`;
        this.elements.endHandle.style.left = `${endPercent}%`;
        this.elements.dualRangeFill.style.left = `${leftPercent}%`;
        this.elements.dualRangeFill.style.width = `${rightPercent - leftPercent}%`;
        
        // Show "--" when no real data is loaded
        if (this.pointsHistory.size === 0) {
            this.elements.startDateLabel.textContent = '--';
            this.elements.endDateLabel.textContent = '--';
            this.elements.message.textContent = '';
        } else {
            // Always show the first and last timestamps of all loaded data
            const [firstDateTime, lastDateTime] = [this.formatDateTime(this.minTimestamp), this.formatDateTime(this.maxTimestamp)];
            this.elements.startDateLabel.textContent = firstDateTime;
            this.elements.endDateLabel.textContent = lastDateTime;
            
            // Show filtered range in the message
            const [startDateTime, endDateTime] = [this.formatDateTime(this.startValue), this.formatDateTime(this.endValue)];
            const filteredCount = Array.from(this.pointsHistory.keys()).filter(
                timestamp => timestamp >= this.startValue && timestamp <= this.endValue
            ).length;
            this.elements.message.textContent = `${filteredCount.toLocaleString()} / ${this.pointsHistory.size.toLocaleString()} points • Filter: ${startDateTime} - ${endDateTime}`;
        }
        
        this.updateAriaAttributes();
    },
    
    getClientX(e) {
        return e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    },
    
    handleStart(e, handle) {
        if (this.pointsHistory.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.isDragging = true;
        this.activeHandle = handle;
        handle.style.cursor = 'grabbing';
        handle.focus();
    },
    
    handleMove(e) {
        if (!this.isDragging || !this.activeHandle) return;
        e.preventDefault();
        const isStart = this.activeHandle === this.elements.startHandle;
        this.updateHandleValue(isStart, this.getValueFromPosition(this.getClientX(e)));
        this.updateDualRange();
        this.drawPoints();
    },
    
    handleEnd() {
        if (!this.isDragging) return;
        this.isDragging = false;
        if (this.activeHandle) {
            this.activeHandle.style.cursor = 'grab';
            this.activeHandle.focus();
        }
        this.activeHandle = null;
        this.drawPoints(true);
    },
    
    handleTrackClick(e) {
        if (this.isDragging || this.pointsHistory.size === 0) return;
        const clickValue = this.getValueFromPosition(this.getClientX(e));
        const isStart = Math.abs(clickValue - this.startValue) < Math.abs(clickValue - this.endValue);
        this.updateHandleValue(isStart, clickValue);
        this.updateDualRange();
        this.drawPoints(true);
    },
    
    moveHandle(handle, direction) {
        if (this.pointsHistory.size === 0) return;
        const isStart = handle === this.elements.startHandle;
        const step = 3600000 * Math.min(1 + this.keyboardAcceleration * 0.15, 8) * direction;
        const currentValue = isStart ? this.startValue : this.endValue;
        this.updateHandleValue(isStart, currentValue + step);
        this.updateDualRange();
        this.drawPoints();
    },
    
    handleKeyboardDown(e, handle) {
        if (this.pointsHistory.size === 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        
        if (this.keyboardInterval && this.keyboardDirection === e.key) return;
        
        if (this.keyboardInterval) clearInterval(this.keyboardInterval);
        
        this.keyboardDirection = e.key;
        this.keyboardAcceleration = 0;
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        
        this.moveHandle(handle, direction);
        
        this.keyboardInterval = setInterval(() => {
            this.keyboardAcceleration++;
            this.moveHandle(handle, direction);
        }, 100);
    },
    
    handleKeyboardUp(e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            if (this.keyboardInterval) {
                clearInterval(this.keyboardInterval);
                this.keyboardInterval = null;
            }
            this.keyboardAcceleration = 0;
            this.keyboardDirection = null;
            this.drawPoints(true);
        }
    },
    
    updateAriaAttributes() {
        [this.elements.startHandle, this.elements.endHandle].forEach((handle, i) => {
            const value = i === 0 ? this.startValue : this.endValue;
            handle.setAttribute('aria-valuemin', this.minTimestamp);
            handle.setAttribute('aria-valuemax', this.maxTimestamp);
            handle.setAttribute('aria-valuenow', value);
        });
    },
    
    // ============================================
    // FILE PROCESSING
    // ============================================
    
    decodeDeltaCompressed(data) {
        if (data.format !== 'delta-compressed' || !data.base || !data.data) {
            return [];
        }
        
        const [baseLatE7, baseLonE7, baseTimeMs] = data.base;
        const locations = [];
        
        locations.push({
            latitudeE7: baseLatE7,
            longitudeE7: baseLonE7,
            timestamp: new Date(baseTimeMs).toISOString()
        });
        
        let currentLatE7 = baseLatE7;
        let currentLonE7 = baseLonE7;
        let currentTimeMs = baseTimeMs;
        
        // Format: data is [delta_lats, delta_lons, delta_times]
        if (Array.isArray(data.data) && data.data.length === 3) {
            const [deltaLats, deltaLons, deltaTimes] = data.data;
            for (let i = 0; i < deltaLats.length; i++) {
                currentLatE7 += deltaLats[i];
                currentLonE7 += deltaLons[i];
                currentTimeMs += deltaTimes[i];
                
                locations.push({
                    latitudeE7: currentLatE7,
                    longitudeE7: currentLonE7,
                    timestamp: new Date(currentTimeMs).toISOString()
                });
            }
        }
        
        return locations;
    },
    
    async decompressFile(file) {
        const isGzip = file.name.endsWith('.gz') || file.name.endsWith('.gzip');
        
        if (!isGzip) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }
        
        // Check if Compression Streams API is available
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream API not supported in this browser. Please use an uncompressed file or a modern browser.');
        }
        
        const arrayBuffer = await file.arrayBuffer();
        const stream = new DecompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        
        writer.write(new Uint8Array(arrayBuffer));
        writer.close();
        
        const chunks = [];
        let done = false;
        
        while (!done) {
            const { value, done: streamDone } = await reader.read();
            done = streamDone;
            if (value) {
                chunks.push(value);
            }
        }
        
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(result);
    },
    
    async parseJson() {
        if (!this.elements.filesInput.files.length) {
            this.elements.message.textContent = '';
            this.elements.progressContainer.classList.add('hidden');
            return;
        }
        
        this.pointsHistory = new Map();
        this.minTimestamp = Infinity;
        this.maxTimestamp = -Infinity;
        const fileCount = this.elements.filesInput.files.length;
        this.elements.progressContainer.classList.remove('hidden');
        this.elements.progressFill.style.width = '0%';
        this.elements.message.textContent = fileCount > 1 ? `Loading ${fileCount} files...` : 'Loading...';

        let loadedCount = 0;
        const totalBytes = Array.from(this.elements.filesInput.files).reduce((sum, file) => sum + file.size, 0);
        let loadedBytes = 0;

        const processFile = (file) => new Promise((resolve, reject) => {
            const updateProgress = () => {
                const overallProgress = (loadedBytes / totalBytes) * 100;
                this.elements.progressFill.style.width = `${overallProgress}%`;
            };
            
            (async () => {
                try {
                    updateProgress();
                    const textContent = await this.decompressFile(file);
                    loadedBytes += file.size;
                    updateProgress();
                    
                    const data = JSON.parse(textContent);
                    
                    let locations = [];
                    if (data.format === 'delta-compressed') {
                        locations = this.decodeDeltaCompressed(data);
                        if (locations.length === 0) {
                            throw new Error(`Failed to decode delta-compressed data. Format: ${data.format}`);
                        }
                    } else if (data.locations) {
                        locations = data.locations;
                    } else {
                        throw new Error(`Unknown file format. Expected location history JSON file (standard or delta-compressed format). File: ${file.name}`);
                    }
                    
                    const processBatch = (batch) => {
                        for (const entry of batch) {
                            if (!('latitudeE7' in entry && 'longitudeE7' in entry && 'timestamp' in entry)) continue;
                            
                            const timestamp = new Date(entry.timestamp).getTime();
                            const coords = [entry.latitudeE7 / 1e7, entry.longitudeE7 / 1e7];
                            this.minTimestamp = Math.min(this.minTimestamp, timestamp);
                            this.maxTimestamp = Math.max(this.maxTimestamp, timestamp);
                            this.pointsHistory.set(timestamp, coords);
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
                                this.elements.progressFill.style.width = `${overallProgress}%`;
                                setTimeout(resolve, 0);
                            });
                        });
                    }
                    
                    loadedCount++;
                    if (loadedCount === fileCount) {
                        this.elements.progressFill.style.width = '100%';
                        setTimeout(() => {
                            this.elements.progressContainer.classList.add('hidden');
                            if (this.minTimestamp === Infinity || this.maxTimestamp === -Infinity) {
                                this.minTimestamp = 0;
                                this.maxTimestamp = 86400000;
                            }
                            this.startValue = this.minTimestamp;
                            this.endValue = this.maxTimestamp;
                            this.updateDualRange();
                            this.updateAriaAttributes();
                            this.fitMapToPoints();
                            this.drawPoints();
                        }, 100);
                    } else {
                        this.elements.message.textContent = `Loaded ${loadedCount}/${fileCount} files...`;
                    }
                    resolve();
                } catch (error) {
                    const errorMsg = error.message.includes('Unknown file format') 
                        ? `Invalid file format: ${file.name}. Please select a location history JSON file (.json or .json.gz)`
                        : `Error loading ${file.name}: ${error.message}`;
                    this.elements.message.textContent = errorMsg;
                    this.elements.progressContainer.classList.add('hidden');
                    reject(error);
                }
            })();
        });
        
        await Promise.all(Array.from(this.elements.filesInput.files).map(processFile));
    },
    
    async loadDefaultHistory() {
        const defaultFile = 'sample-location-history.json.gz';
        
        try {
            const response = await fetch(defaultFile);
            if (!response.ok) {
                this.elements.message.textContent = 'Sample location history not found. You can load your own file using "Load History".';
                return;
            }
            
            const blob = await response.blob();
            const file = new File([blob], defaultFile, { type: 'application/gzip' });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            this.elements.filesInput.files = dataTransfer.files;
            
            await this.parseJson();
        } catch (error) {
            this.elements.message.textContent = `Could not load sample location history: ${error.message}. You can load your own file using "Load History".`;
        }
    },
    
    // ============================================
    // MAP FITTING
    // ============================================
    
    calculateGeometricCenter(points) {
        if (!points.length) return null;
        const sum = points.reduce((acc, [lat, lng]) => [acc[0] + lat, acc[1] + lng], [0, 0]);
        return [sum[0] / points.length, sum[1] / points.length];
    },
    
    calculateDistanceSquared(p1, p2) {
        const dLat = p2[0] - p1[0];
        const dLng = p2[1] - p1[1];
        return dLat * dLat + dLng * dLng;
    },
    
    quickselect(arr, k, left = 0, right = arr.length - 1) {
        if (left === right) return arr[left];
        
        const pivotIndex = this.partition(arr, left, right, Math.floor((left + right) / 2));
        if (k === pivotIndex) return arr[k];
        return k < pivotIndex 
            ? this.quickselect(arr, k, left, pivotIndex - 1)
            : this.quickselect(arr, k, pivotIndex + 1, right);
    },
    
    partition(arr, left, right, pivotIndex) {
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
    },
    
    fitMapToPoints() {
        if (this.pointsHistory.size === 0) return;
        
        const allPoints = Array.from(this.pointsHistory.values());
        const center = this.calculateGeometricCenter(allPoints);
        if (!center) return;
        
        // Calculate squared distances (faster, preserves ordering for percentile)
        const distancesSquared = allPoints.map(point => this.calculateDistanceSquared(center, point));
        
        // Use quickselect to find median without full sort (O(n) vs O(n log n))
        const medianIndex = Math.floor(distancesSquared.length / 2);
        const medianDistanceSquared = this.quickselect([...distancesSquared], medianIndex);
        
        // Calculate bounding box in single pass, filtering by median distance
        let minLat = Infinity, maxLat = -Infinity;
        let minLng = Infinity, maxLng = -Infinity;
        let hasPoints = false;
        
        for (const [lat, lng] of allPoints) {
            if (this.calculateDistanceSquared(center, [lat, lng]) <= medianDistanceSquared) {
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
        this.map.fitBounds(bounds);
    },
    
    // ============================================
    // HEATMAP CONTROLS
    // ============================================
    
    updateSlider(slider, valueElement, property, value) {
        const clamped = Math.max(1, Math.min(10, parseFloat(value)));
        this[property] = clamped;
        slider.value = clamped;
        valueElement.textContent = clamped.toFixed(1);
        slider.setAttribute('aria-valuenow', clamped);
        this.drawMap();
    },
    
    updateRadius(value) {
        this.updateSlider(this.elements.radiusSlider, this.elements.radiusValue, 'heatmapRadius', value);
    },
    
    updateBlur(value) {
        this.updateSlider(this.elements.blurSlider, this.elements.blurValue, 'heatmapBlur', value);
    },
    
    // ============================================
    // THEME SWITCHER
    // ============================================
    
    getSystemPreference() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    
    applyTheme() {
        const theme = localStorage.theme ?? 'system';
        const isDark = theme === 'system' ? this.getSystemPreference() : theme === 'dark';
        document.documentElement.classList.toggle('dark', isDark);
        this.updateThemeButtons(theme);
    },
    
    updateThemeButtons(theme = 'system') {
        const buttons = {
            system: this.elements.themeSystem,
            light: this.elements.themeLight,
            dark: this.elements.themeDark
        };
        
        Object.entries(buttons).forEach(([key, btn]) => {
            if (!btn) return;
            const isActive = key === theme;
            btn.classList.toggle('bg-indigo-600', isActive);
            btn.classList.toggle('text-white', isActive);
            btn.classList.toggle('text-gray-700', !isActive);
            btn.classList.toggle('hover:bg-gray-100', !isActive);
        });
    },
    
    setTheme(theme) {
        theme === 'system' ? localStorage.removeItem('theme') : localStorage.theme = theme;
        this.applyTheme();
    }
};

// Initialize app when DOM is ready
const init = () => {
    LocationHistoryApp.init();
};
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
