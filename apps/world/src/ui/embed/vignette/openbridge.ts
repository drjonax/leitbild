// The one loader of the OpenBridge a vignette draws, in the embed bundle only
// (D-03, T28; policy §5): the palettes' tokens (day, dusk, night by
// data-obc-theme on <html>) and every element and icon the vignette renders,
// each by a bare import, which is what defines it. A type or enum import
// beside one never stands in for it.
import '@oicl/openbridge-webcomponents/dist/openbridge.css'
import '@oicl/openbridge-webcomponents/dist/icons/icon-ai.js'
import '@oicl/openbridge-webcomponents/dist/building-blocks/readout-block/readout-block.js'
import '@oicl/openbridge-webcomponents/dist/building-blocks/bar-horizontal/bar-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/components/status-indicator/status-indicator.js'
import '@oicl/openbridge-webcomponents/dist/automation/bus/bus.js'
import '@oicl/openbridge-webcomponents/dist/automation/switch/switch.js'
import '@oicl/openbridge-webcomponents/dist/automation/transformer/transformer.js'
import '@oicl/openbridge-webcomponents/dist/automation/source/source.js'
