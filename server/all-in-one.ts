// Compatibility entry point for older local commands. The API now owns the
// event-driven engine lifecycle, so starting a second permanent supervisor
// here would reintroduce the memory footprint this architecture removes.
import './index.js';
