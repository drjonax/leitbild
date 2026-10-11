// Ambulance's own test fixture: its response objects beside Weather. Core
// tests use the fixture Pack instead; this file goes with the Ambulance Pack.
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { ambulancePack } from '../src/packs/ambulance/pack.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { PackScenarioRuntimeConfig } from '../src/simulation/protocol.ts'

const packs = [ambulancePack, weatherPack]

export const responseScenario = await compileScenarioDefinition({
  "id": "test-ambulance-response",
  "title": "Ambulance response fixture",
  "packs": [
    {
      "id": "ambulance",
      "config": {},
      "items": [
        {
          "id": "facility:ous",
          "label": "Oslo University Hospital",
          "position": [
            10.7387,
            59.9365
          ],
          "type": "care-site",
          "capabilities": [
            "advanced_life_support"
          ],
          "acceptedUrgencies": [
            "acute",
            "urgent",
            "ordinary"
          ],
          "handoverSlots": 2,
          "handoverSeconds": 120,
          "accepting": true
        },
        {
          "id": "facility:lovisenberg",
          "label": "Lovisenberg Hospital",
          "position": [
            10.7519,
            59.9326
          ],
          "type": "care-site",
          "capabilities": [
            "advanced_life_support"
          ],
          "acceptedUrgencies": [
            "acute",
            "urgent",
            "ordinary"
          ],
          "handoverSlots": 4,
          "handoverSeconds": 120,
          "accepting": true
        },
        {
          "id": "facility:aker",
          "label": "Aker Emergency Clinic",
          "position": [
            10.8001,
            59.9391
          ],
          "type": "care-site",
          "capabilities": [
            "advanced_life_support"
          ],
          "acceptedUrgencies": [
            "acute",
            "urgent",
            "ordinary"
          ],
          "handoverSlots": 5,
          "handoverSeconds": 120,
          "accepting": true
        },
        {
          "id": "amb:a12",
          "label": "Ambulance A-12",
          "atObject": "facility:ous",
          "type": "ambulance",
          "patientCapacity": 1,
          "capabilities": [
            "advanced_life_support",
            "defibrillator",
            "ventilator"
          ],
          "crewReady": true,
          "mobilizationSeconds": 30,
          "sceneSeconds": 120
        },
        {
          "id": "amb:a21",
          "label": "Ambulance A-21",
          "position": [
            10.7707,
            59.9146
          ],
          "type": "ambulance",
          "patientCapacity": 1,
          "capabilities": [
            "advanced_life_support",
            "defibrillator"
          ],
          "crewReady": true,
          "mobilizationSeconds": 30,
          "sceneSeconds": 120
        },
        {
          "id": "amb:a34",
          "label": "Ambulance A-34",
          "position": [
            10.7828,
            59.9237
          ],
          "type": "ambulance",
          "patientCapacity": 1,
          "capabilities": [
            "advanced_life_support",
            "defibrillator"
          ],
          "crewReady": true,
          "mobilizationSeconds": 30,
          "sceneSeconds": 120
        },
        {
          "id": "incident:storo-cleared",
          "label": "Storo collision",
          "position": [
            10.7874,
            59.946
          ],
          "type": "incident",
          "summary": "Storo collision",
          "dispatchUrgency": "urgent"
        },
        {
          "id": "incident:torshov-partial",
          "label": "Torshov bicycle crash",
          "position": [
            10.775,
            59.9328
          ],
          "type": "incident",
          "summary": "Torshov bicycle crash",
          "dispatchUrgency": "urgent"
        },
        {
          "type": "patient",
          "id": "patient:torshov-partial:1",
          "label": "Patient 1",
          "incidentId": "incident:torshov-partial",
          "summary": "Synthetic research fixture patient",
          "assessedUrgency": "urgent",
          "needs": [
            "advanced_life_support"
          ]
        },
        {
          "id": "incident:gronland-unattended",
          "label": "Grønland multi-car crash",
          "position": [
            10.7628,
            59.9124
          ],
          "type": "incident",
          "summary": "Grønland multi-car crash",
          "dispatchUrgency": "acute"
        },
        {
          "type": "patient",
          "id": "patient:gronland-unattended:1",
          "label": "Patient 1",
          "incidentId": "incident:gronland-unattended",
          "summary": "Synthetic research fixture patient",
          "assessedUrgency": "acute",
          "needs": [
            "advanced_life_support"
          ]
        },
        {
          "type": "patient",
          "id": "patient:gronland-unattended:2",
          "label": "Patient 2",
          "incidentId": "incident:gronland-unattended",
          "summary": "Synthetic research fixture patient",
          "assessedUrgency": "acute",
          "needs": [
            "advanced_life_support"
          ]
        },
        {
          "type": "patient",
          "id": "patient:gronland-unattended:3",
          "label": "Patient 3",
          "incidentId": "incident:gronland-unattended",
          "summary": "Synthetic research fixture patient",
          "assessedUrgency": "acute",
          "needs": [
            "advanced_life_support"
          ]
        }
      ],
      "recording": {
        "profileId": "operations"
      }
    },
    {
      "id": "weather",
      "config": {
        "gridResolution": 8
      },
      "items": [
        {
          "type": "weather_area",
          "id": "weather:oslo-damp-background",
          "label": "Damp Oslo background",
          "center": [
            10.7522,
            59.925
          ],
          "semiMajorAxisM": 9000,
          "semiMinorAxisM": 6500,
          "rotationDeg": 15,
          "priority": 0,
          "falloff": "linear",
          "atmosphere": {
            "airTemperatureC": 6,
            "humidity": 0.78,
            "windSpeedMps": 4,
            "windDirectionDeg": 225,
            "visibilityM": 11000,
            "cloudCover": 0.76,
            "precipitation": {
              "type": "none",
              "intensityMmPerHour": 0
            }
          },
          "keyframes": []
        },
        {
          "type": "weather_area",
          "id": "weather:oslo-moving-rain-band",
          "label": "Moving rain band",
          "center": [
            10.69,
            59.925
          ],
          "semiMajorAxisM": 5200,
          "semiMinorAxisM": 1200,
          "rotationDeg": 68,
          "priority": 10,
          "falloff": "linear",
          "atmosphere": {
            "airTemperatureC": 5.5,
            "humidity": 0.9,
            "windSpeedMps": 7,
            "windDirectionDeg": 250,
            "visibilityM": 6500,
            "cloudCover": 0.9,
            "precipitation": {
              "type": "rain",
              "intensityMmPerHour": 1.8
            }
          },
          "keyframes": [
            {
              "atSeconds": 420,
              "center": [
                10.835,
                59.927
              ],
              "semiMajorAxisM": 6800,
              "semiMinorAxisM": 1500,
              "rotationDeg": 78,
              "atmosphere": {
                "precipitation": {
                  "type": "rain",
                  "intensityMmPerHour": 2.3
                },
                "visibilityM": 5200
              }
            }
          ]
        }
      ]
    }
  ],
  "world": {
    "startsAt": "2026-01-01T09:00:00.000Z",
    "environment": {}
  },
  "view": {
    "map": {
      "center": [
        10.7522,
        59.9139
      ],
      "zoom": 12
    }
  }
}, packs, { routing: createDirectRoutingAdapter() })

export const testScenarioRuntimeConfig = (): PackScenarioRuntimeConfig => {
  const runtime = createScenarioRuntimeResolver({ packs }).resolve(responseScenario)
  return {
    scenarioId: runtime.scenarioId,
    runtimeIds: runtime.runtimes.map(runtime => runtime.runtimeId),
    connections: [],
    world: runtime.scenario.world,
    initialObjects: runtime.initialObjects,
    runtimeConfigByRuntimeId: runtime.runtimeConfigByRuntimeId,
    runtimeConfig: {},
  }
}
