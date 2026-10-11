// Behavioral fixtures, deliberately independent of the shipped demo catalog.
import { compileScenarioDefinition } from '../../src/core/scenarios/compiler.ts'
import { scenarioDefinitionSchema } from '../../src/core/scenarios/definition.ts'
import { createDirectRoutingAdapter } from '../../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../../src/scenarios/definitions.ts'
import { testPacks } from './test-packs.ts'

const fixtures = [
  {
    "id": "test-response",
    "title": "Response fixture",
    "packs": [
      {
        "id": "fixture",
        "config": {},
        "items": [
          {
            "id": "site:north",
            "label": "North site",
            "position": [
              10.7387,
              59.9365
            ],
            "type": "site"
          },
          {
            "id": "site:centre",
            "label": "Centre site",
            "position": [
              10.7519,
              59.9326
            ],
            "type": "site"
          },
          {
            "id": "site:east",
            "label": "East site",
            "position": [
              10.8001,
              59.9391
            ],
            "type": "site"
          },
          {
            "id": "unit:a12",
            "label": "Unit A-12",
            "atObject": "site:north",
            "type": "unit",
            "speedMps": 15
          },
          {
            "id": "unit:a21",
            "label": "Unit A-21",
            "position": [
              10.7707,
              59.9146
            ],
            "type": "unit",
            "speedMps": 15
          },
          {
            "id": "unit:a34",
            "label": "Unit A-34",
            "position": [
              10.7828,
              59.9237
            ],
            "type": "unit",
            "speedMps": 15
          },
          {
            "id": "task:alpha",
            "label": "Task Alpha",
            "position": [
              10.7874,
              59.946
            ],
            "type": "task",
            "priority": "normal"
          },
          {
            "id": "task:bravo",
            "label": "Task Bravo",
            "position": [
              10.775,
              59.9328
            ],
            "type": "task",
            "priority": "normal"
          },
          {
            "id": "task:charlie",
            "label": "Task Charlie",
            "position": [
              10.7628,
              59.9124
            ],
            "type": "task",
            "priority": "high"
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
      },
      "rail": {
        "sections": [
          {
            "categoryId": "sites",
            "visible": true,
            "collapsed": false,
            "visibleFields": []
          },
          {
            "categoryId": "units",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "speed"
            ]
          },
          {
            "categoryId": "tasks",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "priority"
            ]
          },
          {
            "categoryId": "weather",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "air-temperature",
              "precipitation",
              "surface"
            ]
          }
        ]
      }
    },
    "timeline": {
      "cues": [
        {
          "id": "scenario-started",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 0
          },
          "actions": [
            {
              "type": "show_guidance",
              "guidance": {
                "id": "welcome",
                "title": "Fixture overview",
                "message": "Fixture guidance",
                "objectIds": [
                  "unit:a12",
                  "task:charlie"
                ],
                "dismissible": true
              }
            },
            {
              "type": "highlight_objects",
              "objectIds": [
                "unit:a12",
                "task:charlie"
              ]
            }
          ]
        },
        {
          "id": "task-bravo-raised",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 45
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.set-priority",
              "input": {
                "taskId": "task:bravo",
                "priority": "high"
              }
            },
            {
              "type": "show_guidance",
              "guidance": {
                "id": "bravo-raised",
                "title": "Priority raised",
                "tone": "update",
                "message": "Fixture guidance",
                "objectIds": [
                  "task:bravo"
                ],
                "dismissible": true
              }
            },
            {
              "type": "highlight_objects",
              "objectIds": [
                "task:bravo"
              ]
            }
          ]
        },
        {
          "id": "task-delta-created",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 120
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.create-item",
              "input": {
                "item": {
                  "id": "task:delta",
                  "label": "Task Delta",
                  "position": [
                    10.7146,
                    59.9292
                  ],
                  "type": "task",
                  "priority": "normal"
                }
              }
            },
            {
              "type": "show_guidance",
              "guidance": {
                "id": "delta-created",
                "title": "New task",
                "message": "Fixture guidance",
                "objectIds": [
                  "task:delta"
                ],
                "dismissible": true
              }
            },
            {
              "type": "highlight_objects",
              "objectIds": [
                "task:delta"
              ]
            }
          ]
        },
        {
          "id": "task-delta-raised",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 165
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.set-priority",
              "input": {
                "taskId": "task:delta",
                "priority": "high"
              }
            },
            {
              "type": "show_guidance",
              "guidance": {
                "id": "delta-raised",
                "title": "Priority raised",
                "tone": "update",
                "message": "Fixture guidance",
                "objectIds": [
                  "task:delta"
                ],
                "dismissible": true
              }
            }
          ]
        },
        {
          "id": "task-echo-created",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 300
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.create-item",
              "input": {
                "item": {
                  "id": "task:echo",
                  "label": "Task Echo",
                  "position": [
                    10.8061,
                    59.9362
                  ],
                  "type": "task",
                  "priority": "high"
                }
              }
            },
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.create-item",
              "input": {
                "item": {
                  "id": "site:echo",
                  "label": "Echo staging site",
                  "atObject": "task:echo",
                  "type": "site"
                }
              }
            },
            {
              "type": "show_guidance",
              "guidance": {
                "id": "echo-created",
                "title": "Escalation",
                "message": "Fixture guidance",
                "objectIds": [
                  "task:echo"
                ],
                "dismissible": true
              }
            },
            {
              "type": "highlight_objects",
              "objectIds": [
                "task:echo"
              ]
            }
          ]
        },
        {
          "id": "task-charlie-lowered",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 360
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.fixture.set-priority",
              "input": {
                "taskId": "task:charlie",
                "priority": "low"
              }
            },
            {
              "type": "show_guidance",
              "guidance": {
                "id": "charlie-lowered",
                "title": "Priority lowered",
                "tone": "update",
                "message": "Fixture guidance",
                "objectIds": [
                  "task:charlie"
                ],
                "dismissible": true
              }
            }
          ]
        },
        {
          "id": "task-delta-removed",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 420
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.object.delete",
              "input": {
                "objectId": "task:delta"
              }
            }
          ]
        }
      ]
    },
    "objectives": []
  },
  {
    "id": "test-drone",
    "title": "Drone fixture",
    "packs": [
      {
        "id": "fixture",
        "config": {},
        "items": [
          {
            "id": "site:drone-base",
            "label": "Drone base",
            "position": [
              10.7387,
              59.9365
            ],
            "type": "site"
          },
          {
            "id": "unit:drone-target-a12",
            "label": "Unit A-12",
            "atObject": "site:drone-base",
            "type": "unit",
            "speedMps": 15
          },
          {
            "id": "unit:drone-target-a21",
            "label": "Unit A-21",
            "position": [
              10.7605,
              59.9144
            ],
            "type": "unit",
            "speedMps": 15
          },
          {
            "id": "task:drone-search",
            "label": "Riverside search",
            "position": [
              10.7442,
              59.9068
            ],
            "type": "task",
            "priority": "normal"
          }
        ]
      },
      {
        "id": "drone",
        "config": {
          "maxDrones": 10,
          "stepIntervalMs": 20,
          "projectionIntervalMs": 33,
          "models": [
            {
              "id": "native-vision-micro",
              "label": "Vision Micro",
              "description": "Compact native Leitbild vision quad for quiet observation tasks.",
              "nominalEnduranceMinutes": 35,
              "airframe": {
                "kind": "quadrotor",
                "rotorCount": 4,
                "massKg": 0.78,
                "diagonalSizeM": 0.24
              },
              "flightEnvelope": {
                "cruiseSpeedMps": 14,
                "maxHorizontalSpeedMps": 26,
                "maxVerticalSpeedMps": 5,
                "maxAccelerationMps2": 8,
                "maxYawRateDegPerSec": 130,
                "arrivalRadiusM": 3
              },
              "capabilities": [
                {
                  "id": "manual-control",
                  "kind": "manual_control",
                  "label": "Manual control",
                  "source": "runtime"
                },
                {
                  "id": "guided-navigation",
                  "kind": "guided_navigation",
                  "label": "Guided navigation",
                  "source": "runtime"
                },
                {
                  "id": "mission",
                  "kind": "mission",
                  "label": "Mission execution",
                  "source": "runtime"
                },
                {
                  "id": "surveillance",
                  "kind": "surveillance",
                  "label": "Surveillance",
                  "source": "payload"
                }
              ],
              "sensors": [
                {
                  "id": "wide-camera",
                  "kind": "electro_optical",
                  "label": "Wide camera",
                  "rangeM": 450,
                  "fovDeg": 100,
                  "updateIntervalMs": 500,
                  "source": "payload"
                }
              ],
              "payloads": [],
              "visual": {
                "color": "#2563eb",
                "accentColor": "#f5f3ff",
                "scale": 0.78
              }
            },
            {
              "id": "native-effect-quad",
              "label": "Effect Quad",
              "description": "Native Leitbild quad with an operator-declared training effect payload.",
              "nominalEnduranceMinutes": 25,
              "airframe": {
                "kind": "quadrotor",
                "rotorCount": 4,
                "massKg": 3.2,
                "diagonalSizeM": 0.52
              },
              "flightEnvelope": {
                "cruiseSpeedMps": 24,
                "maxHorizontalSpeedMps": 48,
                "maxVerticalSpeedMps": 11,
                "maxAccelerationMps2": 16,
                "maxYawRateDegPerSec": 170,
                "arrivalRadiusM": 5
              },
              "capabilities": [
                {
                  "id": "manual-control",
                  "kind": "manual_control",
                  "label": "Manual control",
                  "source": "runtime"
                },
                {
                  "id": "guided-navigation",
                  "kind": "guided_navigation",
                  "label": "Guided navigation",
                  "source": "runtime"
                },
                {
                  "id": "mission",
                  "kind": "mission",
                  "label": "Mission execution",
                  "source": "runtime"
                },
                {
                  "id": "effect-delivery",
                  "kind": "effect_delivery",
                  "label": "Effect delivery",
                  "source": "operator_declared"
                }
              ],
              "sensors": [
                {
                  "id": "tracking-camera",
                  "kind": "tracking_camera",
                  "label": "Tracking camera",
                  "rangeM": 900,
                  "fovDeg": 50,
                  "updateIntervalMs": 300,
                  "source": "payload"
                }
              ],
              "payloads": [
                {
                  "id": "kinetic-effect",
                  "kind": "kinetic",
                  "label": "Training effect",
                  "massKg": 0.7,
                  "quantity": 1,
                  "rangeM": 75,
                  "effect": {
                    "kind": "training-effect",
                    "damage": 0.65,
                    "radiusM": 3,
                    "cooldownSeconds": 8
                  },
                  "source": "operator_declared"
                }
              ],
              "visual": {
                "color": "#b91c1c",
                "accentColor": "#fee2e2",
                "scale": 1.08
              }
            }
          ]
        },
        "items": [
          {
            "type": "drone",
            "id": "drone:oslo-survey-1",
            "label": "Survey 1",
            "position": [
              10.7488,
              59.9141
            ],
            "modelId": "native-survey-quad",
            "altitudeM": 55,
            "headingDeg": 35,
            "swarm": {
              "swarmId": "swarm:oslo-blue",
              "role": "leader",
              "slot": [
                0,
                0,
                0
              ],
              "separationRadiusM": 10
            }
          },
          {
            "type": "drone",
            "id": "drone:oslo-survey-2",
            "label": "Survey 2",
            "position": [
              10.7479,
              59.9137
            ],
            "modelId": "native-vision-micro",
            "altitudeM": 48,
            "headingDeg": 35,
            "swarm": {
              "swarmId": "swarm:oslo-blue",
              "role": "member",
              "slot": [
                18,
                -18,
                0
              ],
              "separationRadiusM": 8
            }
          },
          {
            "type": "drone",
            "id": "drone:oslo-supply-1",
            "label": "Supply 1",
            "position": [
              10.7429,
              59.916
            ],
            "modelId": "native-gimbal-quad",
            "altitudeM": 38,
            "headingDeg": 92
          },
          {
            "type": "drone",
            "id": "drone:oslo-interceptor-1",
            "label": "Interceptor 1",
            "position": [
              10.757,
              59.9138
            ],
            "modelId": "native-effect-quad",
            "altitudeM": 42,
            "headingDeg": 260
          }
        ]
      }
    ],
    "world": {
      "startsAt": "2026-01-01T10:00:00.000Z",
      "environment": {}
    },
    "view": {
      "map": {
        "center": [
          10.7522,
          59.9139
        ],
        "zoom": 13.5
      },
      "rail": {
        "sections": [
          {
            "categoryId": "drones",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "model",
              "link",
              "mode",
              "altitude",
              "battery",
              "health",
              "payloads"
            ]
          },
          {
            "categoryId": "units",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "speed",
              "task"
            ]
          },
          {
            "categoryId": "tasks",
            "visible": true,
            "collapsed": false,
            "visibleFields": [
              "priority",
              "unit"
            ]
          }
        ]
      }
    },
    "timeline": {
      "cues": [
        {
          "id": "drone-ops-auto-arm-survey",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 0.5
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.drone.arm",
              "input": {
                "droneId": "drone:oslo-survey-1",
                "armed": true
              }
            }
          ]
        },
        {
          "id": "drone-ops-auto-takeoff-survey",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 1
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.drone.takeoff",
              "input": {
                "droneId": "drone:oslo-survey-1",
                "altitudeM": 55
              }
            }
          ]
        },
        {
          "id": "drone-ops-briefing",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 2
          },
          "actions": [
            {
              "type": "show_guidance",
              "guidance": {
                "id": "drone-ops-briefing",
                "title": "Drone operations",
                "message": "Fixture guidance",
                "objectIds": [
                  "drone:oslo-survey-1",
                  "drone:oslo-survey-2",
                  "drone:oslo-interceptor-1"
                ],
                "dismissible": true
              }
            }
          ]
        },
        {
          "id": "drone-ops-auto-survey-leg",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 4
          },
          "actions": [
            {
              "type": "invoke_capability",
              "capabilityId": "world.drone.navigate",
              "input": {
                "droneId": "drone:oslo-survey-1",
                "target": {
                  "point": {
                    "type": "Point",
                    "coordinates": [
                      10.7442,
                      59.9068
                    ]
                  },
                  "altitudeM": 55,
                  "speedMps": 18
                }
              }
            }
          ]
        }
      ]
    },
    "objectives": []
  },
  {
    "id": "test-plant",
    "title": "Plant persistence fixture",
    "packs": [
      {
        "id": "process-plant",
        "config": {},
        "items": [
          {
            "type": "plant",
            "id": "plant:halden-a1",
            "label": "Halden Unit A1",
            "clusterId": "cluster-a",
            "coolingWater": "Tista river / Halden harbor",
            "location": [
              11.3714,
              59.1198
            ],
            "model": {
              "ref": "process-plant.pwr.reference",
              "parameters": {
                "loopCount": 4
              }
            },
            "operatingPoint": {
              "ref": "process-plant.pwr.full-power",
              "parameterOverrides": {
                "core": {
                  "initialPowerFraction": 0.992
                },
                "turbine": {
                  "initialLoadFraction": 0.992
                }
              },
              "valueOverrides": {
                "pressurizer.pressureMPa": 15.47,
                "sgA.levelPercent": 54.8,
                "sgA.collapsedLevelPercent": 53,
                "sgA.secondaryInventoryKg": 29680,
                "sgA.steamMassKg": 11940,
                "feedwaterControlValveA.positionFraction": 0.905
              }
            },
            "automation": {
              "ref": "process-plant.pwr.standard"
            }
          }
        ],
        "recording": {
          "profileId": "operations"
        }
      }
    ],
    "world": {
      "startsAt": "2026-01-01T10:00:00.000Z",
      "environment": {}
    },
    "view": {
      "map": {
        "center": [
          11.389,
          59.1185
        ],
        "zoom": 13
      }
    },
    "timeline": {
      "cues": []
    },
    "objectives": []
  },
  {
    "id": "test-grid",
    "title": "Grid fixture",
    "packs": [
      {
        "id": "electric-grid",
        "config": {},
        "items": [
          {
            "type": "grid",
            "id": "grid:norway",
            "label": "Norway transmission grid",
            "location": [
              15.5,
              64.7
            ],
            "model": {
              "ref": "electric-grid.norway.transmission"
            },
            "operatingPoint": {
              "ref": "electric-grid.norway.summer-night-low"
            },
            "automation": {
              "ref": "electric-grid.frequency.nordic-2025"
            }
          }
        ]
      }
    ],
    "world": {
      "startsAt": "2026-01-01T10:00:00.000Z",
      "environment": {}
    },
    "view": {
      "map": {
        "center": [
          10.5,
          62.4
        ],
        "zoom": 5
      },
      "rail": {
        "sections": [
          {
            "categoryId": "electric-grids",
            "collapsed": true
          }
        ]
      }
    },
    "timeline": {
      "cues": [
        {
          "id": "grid-intro-guidance",
          "at": {
            "kind": "after_scenario_start",
            "seconds": 1
          },
          "title": "Grid operations intro",
          "actions": [
            {
              "type": "show_guidance",
              "guidance": {
                "id": "grid-intro",
                "title": "Norway electric-grid operations",
                "message": "Fixture guidance",
                "objectIds": [
                  "grid:norway"
                ],
                "dismissible": true,
                "tone": "default"
              }
            }
          ]
        }
      ]
    },
    "objectives": []
  }
]

// The shipped Scenarios that core and Pack tests also run, named one by one
// so a built-in whose Packs change fails here instead of dropping out.
const builtinIds = [
  'halden-offsite-power-restoration',
  'halden-power-complex',
  'nordic-frequency-event',
  'nordland-corridor-security',
  'rogaland-black-start',
] as const
const builtins = builtinIds.map(id => {
  const source = builtinScenarioDefinitions.find(candidate => candidate.id === id)
  if (!source) throw new Error(`missing built-in Scenario: ${id}`)
  return source
})

export const testScenarioDefinitions = [...fixtures.map(source => scenarioDefinitionSchema.parse(source)), ...builtins]
export const scenarios = await Promise.all(testScenarioDefinitions.map(source =>
  compileScenarioDefinition(source, testPacks, { routing: createDirectRoutingAdapter() })))
export const responseScenario = scenarios.find(scenario => scenario.id === 'test-response')!
