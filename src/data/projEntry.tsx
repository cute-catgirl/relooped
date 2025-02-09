import Spacer from "components/layout/Spacer.vue";
import { jsx } from "features/feature";
import { Resource, createResource, trackBest, trackOOMPS, trackTotal } from "features/resources/resource";
import type { GenericTree } from "features/trees/tree";
import { branchedResetPropagation, createTree } from "features/trees/tree";
import { globalBus } from "game/events";
import type { BaseLayer, GenericLayer } from "game/layers";
import { createLayer } from "game/layers";
import type { Player } from "game/player";
import player from "game/player";
import { DecimalSource, formatWhole } from "util/bignum";
import Decimal, { format, formatTime } from "util/bignum";
import { render } from "util/vue";
import { computed, ref, toRaw } from "vue";
import gameLayer from "./layers/game";
import { BoardNode, GenericBoard, ProgressDisplay, Shape, createBoard } from "features/boards/board";
import { Persistent, noPersist, persistent } from "game/persistence";
import InfoVue from "components/Info.vue";
import OptionsVue from "components/Options.vue";
import SavesManagerVue from "components/SavesManager.vue";
import ChangelogVue from "./Changelog.vue";
import ModalVue from "components/Modal.vue";
import { Computable } from "util/computed";
import * as b from "./types/buildings";
import { BuildingType, CapsuleUpgrade, Objective, SpecialObjective } from "./types/data";
import { GenericUpgrade, createUpgrade } from "features/upgrades/upgrade";
import { createCostRequirement } from "game/requirements";
import Formula from "game/formulas/formulas";
import { GenericRepeatable, createRepeatable } from "features/repeatable";
import layer from "./layers/game";

const buildings = b as { [key: string]: BuildingType };

export type GameModeInfo = {
    name: string;
    description: string;
    multiplier: number;
}

enum HubState {
    Idle = "idle",
    Transitioning = "trans",
}

export let gameModes = {
    standard: {
        name: "Standard",
        description: "The default game mode.\nStandard rules apply.",
        multiplier: 1
    },
    boosted: {
        name: "Boosted",
        description: "Harder enemies.\nFaster health drain.",
        multiplier: 1.5
    },
    hardcore: {
        name: "Hardcore",
        description: "Hardest enemies.\nNo speed changes.\nStress = Lethal.",
        multiplier: 2
    },
} as Record<string, GameModeInfo>;
export let gameModeArray = ["standard", "boosted", "hardcore"];

/**
 * @hidden
 */
export const main = createLayer("main", function (this: BaseLayer) {
    const points = createResource<number>(300, "xp");
    const total = trackTotal(points);
    
    const capsules = createResource<number>(0, "💊");
    const timeSinceLastClaim = persistent<number>(0);

    const hubState = ref("idle");

    let bestCycle = {
        standard: persistent<number>(0),
        boosted: persistent<number>(0),
        hardcore: persistent<number>(0),
    } as Record<string, Persistent<number>>;

    let selectedGameMode = persistent<string>("standard", false);

    let unlockedBuildings = persistent<Record<string, boolean>>({ 
        beamer: true, 
        plasma: true, 
        freezer: true, 
        energizer: true,
    });
    let selectedBuildings = persistent<string[]>(["beamer", "plasma", "freezer", "energizer"]);
    let focusedBuilding = ref("");

    let unlocks = {
        collection: persistent(false),
        research: persistent(false),
        objectives: persistent(false),
        capsules: persistent(false),
    } as Record<string, Persistent<boolean>>;
    
    const isAnimating = ref<boolean>(false);

    function intro(duration = 1000) {
        isAnimating.value = true;
        let start: number | null = null;
        board.stage.value?.setMinZoom(0.1);
        function frame(time: number) {
            if (start === null) start = time;
            time = (time - start) / duration;
            
            let lerp = 1 - (1000 ** (1 - time) - 1) / 999;
            board.stage.value?.zoomAbs(window.innerWidth / 2, window.innerHeight / 2, Math.max(lerp, 1e-6));

            if (time < 1) requestAnimationFrame(frame);
            else isAnimating.value = false;
        }
        requestAnimationFrame(frame);
    }

    function outtro(duration = 1000) {
        isAnimating.value = true;
        let currentZoom = board.stage.value.getTransform().scale;
        let start: number | null = null;
        board.stage.value.smoothMoveTo(window.innerWidth / 2, window.innerHeight / 2);
        board.stage.value.setMinZoom(0);
        function frame(time: number) {
            if (start === null) start = time;
            time = (time - start) / duration;
            
            let lerp = (1000 ** time - 1) / 999;
            board.stage.value.zoomAbs(window.innerWidth / 2, window.innerHeight / 2, Math.max(currentZoom * (1 - lerp), 1e-6));

            if (time < 1) requestAnimationFrame(frame);
            else isAnimating.value = false;
        }
        requestAnimationFrame(frame);
    }

    let upgrades = {
        startEnergy: createRepeatable(self => ({
            display: {
                title: "Better Funding",
                description: "Increase the starting Energy budget by 25.",
                effectDisplay: jsx(() => <>{formatWhole(Decimal.mul(self.amount.value, 25).add(100))}</>),
                showAmount: false,
            },
            limit: 9,
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.3).mul(200).sub(200),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        maxBuildings: createRepeatable(self => ({
            display: {
                title: "Bigger Inventory",
                description: "Increase the maximum amount of buildings you can equip by 1.",
                effectDisplay: jsx(() => <>{formatWhole(Decimal.add(self.amount.value, 6))} / 14</>),
                showAmount: false,
            },
            limit: 8,
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.6).mul(300),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        speedManip: createRepeatable(self => ({
            display: {
                title: "Speed Manipulation",
                description: jsx(() => <>
                    Unlock {Decimal.gte(self.amount.value, 1) ? formatWhole(Decimal.add(self.amount.value, 1).min(4)) + "x / 4x speed change" : "pausing"}.
                    <br/>Is disabled on certain game modes.
                </>),
                showAmount: false,
            },
            limit: 4,
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(3).mul(200),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        sellCooldown: createRepeatable(self => ({
            display: {
                title: "Decommission Machine",
                description: "Reduce the selling cooldown by 5 seconds.",
                effectDisplay: jsx(() => <>{formatWhole(Decimal.mul(self.amount.value, -5).add(60))}s / 10s</>),
                showAmount: false,
            },
            limit: 10,
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.4).mul(200),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        capsuleGain: createRepeatable(self => ({
            display: {
                title: "Capsule Productor",
                description: "Increase capsule's production speed by 1%.",
                effectDisplay: jsx(() => <>+{formatWhole(self.amount.value)}%</>),
                showAmount: false,
            },
            visibility: noPersist(unlocks.capsules),
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.3).mul(175),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        capsuleCap: createRepeatable(self => ({
            display: {
                title: "Capsule Storage",
                description: "Increase capsule's maximum storage by 1.",
                effectDisplay: jsx(() => <>+{formatWhole(self.amount.value)}</>),
                showAmount: false,
            },
            visibility: noPersist(unlocks.capsules),
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.6).mul(200),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
        startInfo: createRepeatable(self => ({
            display: {
                title: "Head Start",
                description: "Increase the starting Information budget by 50.",
                effectDisplay: jsx(() => <>{formatWhole(Decimal.mul(self.amount.value, 50))}</>),
                showAmount: false,
            },
            visibility: noPersist(computed(() => unlockedBuildings.value["observer"] == true)),
            requirements: createCostRequirement(() => ({
                resource: noPersist(points),
                cost: Formula.variable(self.amount).pow_base(1.5).mul(400),
            })),
            style: { width: "225px", padding: "0 10px" },
        })),
    } as Record<string, GenericRepeatable>;
    
    let buildingUpgrades: { [key: string]: { [key: string]: GenericUpgrade } } = {
        beamer: {
            cost: createUpgrade(self => ({
                display: {
                    title: "Cheaper Beamer",
                    description: "Decrease the base cost by 5",
                },
                requirements: createCostRequirement(() => ({
                    resource: noPersist(points),
                    cost: 200
                })),
            }))
        }
    }

    const stats = {
        bestEnergy: trackBest(gameLayer.resourcesTotal.energy),
        bestInfo: trackBest(gameLayer.resourcesTotal.info),
        bestTime: trackBest(gameLayer.lifetime),
    }

    let objectives = persistent<Record<string, number>>({});

    let objectiveViewMode = ref("normal");

    let normalObjectives = {
        standardCycle: {
            name: "First Cycle",
            description: "Reach Cycle {0} in Standard mode.",
            target: noPersist(bestCycle.standard),
            goal: (x) => 10 + x * 5,
            reward: (x) => ["xp", 10 + x * (x + 1) * (x + 2) / 6],
            exclusiveRewards: {
                3: ["building", "splatter"],
                6: ["building", "blaster"],
                9: ["building", "splitter"],
                12: ["building", "thunder"],
            }
        },
        boostedCycle: {
            name: "Second Cycle",
            description: "Reach Cycle {0} in Boosted mode.",
            target: noPersist(bestCycle.boosted),
            goal: (x) => 10 + x * 5,
            reward: (x) => ["xp", 12 + x * (x + 1) * (x + 2) / 3],
            exclusiveRewards: {
                3: ["building", "bomber"],
                6: ["building", "hourglass"],
                9: ["building", "decayer"],
            }
        },
        hardcoreCycle: {
            name: "Third Cycle",
            description: "Reach Cycle {0} in Hardcore mode.",
            target: noPersist(bestCycle.hardcore),
            goal: (x) => 10 + x * 5,
            reward: (x) => ["xp", 15 + x * (x + 1) * (x + 2) / 2],
            exclusiveRewards: {
                3: ["building", "igniter"],
                6: ["building", "pagoda"],
            }
        },
        upgradeCount: {
            name: "Not Really a Fair Game",
            description: "Buy {0} Researches.",
            target: computed(() => Object.values(upgrades).reduce((x, y) => Decimal.add(x, y.amount.value).toNumber(), 0)),
            goal: (x) => 3 + x * 2,
            reward: (x) => ["capsules", Math.floor(3 + x / 2)],
            exclusiveRewards: {
                3: ["building", "observer"],
                6: ["building", "overclocker"],
                9: ["building", "sharpener"],
                12: ["building", "stunner"],
            }
        },
        capsuleCount: {
            name: "Is This P2W?",
            description: "Open {0} 💊.",
            target: computed(() => Object.values(allocatedCapsules.value).reduce((x, y) => x + y, 0)),
            goal: (x) => 10 + x * 4 + x * (x + 1) / 2 + Math.floor(x * x * x  / 32),
            reward: (x) => ["xp", 50 + x * 4 + x * (x + 1) * (x + 2) / 6],
            exclusiveRewards: {
                3: ["building", "synthesizer"],
                6: ["building", "expander"],
                9: ["building", "winderR"],
                12: ["building", "antiwinder"],
            }
        },
        totalXP: {
            name: "Look how much you've grown!",
            description: "Gain a total of {0} XP.",
            target: noPersist(total),
            goal: (x) => 500 + x * (x + 1) * (x + 2) * 250,
            reward: (x) => ["capsules", Math.floor(3 + x / 2)],
            exclusiveRewards: {
                3: ["building", "lengthener"],
                6: ["building", "swamp"],
            }
        },
        bestEnergy: {
            name: "Power Player",
            description: "Reach a best total Energy of {0}.",
            target: noPersist(stats.bestEnergy),
            goal: (x) => 10000 + x * (x + 1) * (x + 2) * 500,
            reward: (x) => ["xp", 20 + x * (x + 1) * (x + 2) * 1.5],
            exclusiveRewards: {
                3: ["building", "multiplier"],
                5: ["building", "fox"],
            }
        },
        bestInfo: {
            name: "Knowledged Looper",
            description: "Reach a best total Information of {0}.",
            target: noPersist(stats.bestInfo),
            goal: (x) => 1000 + x * (x + 1) * (x + 2) * 50,
            reward: (x) => ["xp", 40 + x * (x + 1) * (x + 2) * 2.5],
            exclusiveRewards: {
                3: ["building", "thinker"],
                5: ["building", "turtle"],
            }
        },
        bestTime: {
            name: "Marathoner",
            description: "Have a {0} seconds long game.",
            target: noPersist(stats.bestTime),
            goal: (x) => 300 + x * 80 + x * x * 20,
            reward: (x) => ["xp", 40 + x * (x + 1) * (x + 2)],
            exclusiveRewards: {
                3: ["building", "tachyon"],
                6: ["building", "snail"],
            }
        },
        meta: {
            name: "Very Creative Objective",
            description: "Complete {0} Objectives.",
            target: computed(() => Object.values(objectives.value).reduce((x, y) => x + y, 0)),
            goal: (x) => 20 + x * 4 + x * (x + 1) / 2,
            reward: (x) => ["capsules", Math.floor(3 + x / 3)],
            exclusiveRewards: {
                2: ["building", "xray"],
                5: ["building", "winderL"],
                8: ["building", "winder"],
            }
        },
    } as Record<string, Objective>;

    let specialObjectives = {
        anxiety: {
            name: "Anxiety",
            description: "Reach a stress level of 200%.",
            reward: ["building", "stablizer"],
        },
        stucked: {
            name: "Stucked",
            description: "Get yourself into a \"softlocked\" state.",
            reward: ["building", "pins"],
        },
        wysi: {
            name: "All-Seeing",
            description: "Have *exactly* 727 Energy at some point.",
            reward: ["building", "wysi"],
        },
    } as Record<string, SpecialObjective>;
    
    let allocatedCapsules = persistent<Record<string, number>>({});

    let capsuleUpgrades = {
        xp: {
            name: "XP Core",
            description: "+{0}% xp gain.",
            formula: (x) => x,
        },
        energy: {
            name: "Energy Core",
            description: "+{0} starting Energy.",
            formula: (x) => x,
        },
        capsules: {
            name: "Capsule Core",
            description: "+{0}% capsule production.",
            formula: (x) => Math.sqrt(x),
            precision: 2,
        },
        capacity: {
            name: "Capacity Core",
            description: "+{0} capsule capacity.",
            formula: (x) => Math.sqrt(x / 10),
            precision: 2,
        },
    } as Record<string, CapsuleUpgrade>;

    function getCapsuleEffect(id: string) {
        return capsuleUpgrades[id].formula(allocatedCapsules.value[id] ?? 0);
    }

    globalBus.on("onLoad", () => {
        for (let [id, obj] of Object.entries(normalObjectives)) {
            for (let [goal, exc] of Object.entries(obj.exclusiveRewards)) {
                if ((objectives.value[id] ?? 0) > +goal) {
                    if (exc[0] == "building") {
                        unlockedBuildings.value[exc[1]] = true;
                    }
                }
            }
        }
        for (let [id, obj] of Object.entries(specialObjectives)) {
            if ((objectives.value[id] ?? 0) >= 1) {
                if (obj.reward[0] == "building") {
                    unlockedBuildings.value[obj.reward[1]] = true;
                }
            }
        }
    })

    const board = createBoard(() => ({
        startNodes: () => [],
        state() {
            let nodes: BoardNode[] = [
                { 
                    id: 0, type: "play",
                    position: { 
                        x: 0, 
                        y: 0 
                    }, 
                },
                { 
                    id: 1, type: "info",
                    position: { 
                        x: Math.sin(player.timePlayed / 20) * 150, 
                        y: Math.cos(player.timePlayed / 20) * 150,  
                    }, 
                },
                { 
                    id: 2, type: "setting",
                    position: { 
                        x: Math.sin(player.timePlayed / 20 + Math.PI * 0.66667) * 150, 
                        y: Math.cos(player.timePlayed / 20 + Math.PI * 0.66667) * 150,  
                    }, 
                },
                { 
                    id: 3, type: "saves",
                    position: { 
                        x: Math.sin(player.timePlayed / 20 + Math.PI * 1.33333) * 150, 
                        y: Math.cos(player.timePlayed / 20 + Math.PI * 1.33333) * 150,  
                    }, 
                },
                { 
                    id: 4, type: "collection",
                    position: { 
                        x: Math.sin(player.timePlayed / -50) * 300, 
                        y: Math.cos(player.timePlayed / -50) * 300,  
                    }, 
                },
                { 
                    id: 5, type: "research",
                    position: { 
                        x: Math.sin(player.timePlayed / -50 + Math.PI) * 300, 
                        y: Math.cos(player.timePlayed / -50 + Math.PI) * 300,  
                    }, 
                },
                { 
                    id: 6, type: "objectives",
                    position: { 
                        x: Math.sin(player.timePlayed / -50 + Math.PI * .5) * 300, 
                        y: Math.cos(player.timePlayed / -50 + Math.PI * .5) * 300,  
                    }, 
                },
                { 
                    id: 7, type: "capsules",
                    position: { 
                        x: Math.sin(player.timePlayed / -50 + Math.PI * 1.5) * 300, 
                        y: Math.cos(player.timePlayed / -50 + Math.PI * 1.5) * 300,  
                    }, 
                },
            ];

            return {
                nodes,
                selectedNode: null,
                selectedAction: null,
            }
        },
        classes: { "hub-board": true },
        types: { 
            play: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 80,
                title: "▶",
                onClick(node) {
                    showGameModal();
                }
            },
            info: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 30,
                title: "i",
                onClick(node) {
                    (document.querySelector(".overlay-nav :nth-child(4)") as HTMLElement)?.click();
                }
            },
            setting: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 30,
                title: "⚙️",
                onClick(node) {
                    (document.querySelector(".overlay-nav :nth-child(3)") as HTMLElement)?.click();
                }
            },
            saves: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 30,
                title: "💾",
                onClick(node) {
                    (document.querySelector(".overlay-nav :nth-child(2)") as HTMLElement)?.click();
                }
            },
            collection: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 50,
                title: "📚",
                onClick(node) {
                    showCollectionModal();
                }
            },
            research: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 50,
                title: "🔬",
                onClick(node) {
                    showResearchModal();
                }
            },
            objectives: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 50,
                title: "🎯",
                onClick(node) {
                    showObjectivesModal();
                }
            },
            capsules: {
                shape: Shape.Circle,
                fillColor: "#afcfef",
                size: 50,
                title: "💊",
                onClick(node) {
                    showCapsuleModal();
                }
            },
        },
    })) as GenericBoard;

    function showGameModal() {
        hubModalHeader.value = <>
            <h1 class="result-title">NEW GAME</h1>
            <h2 style="font-style: italic;">
                - Select your game mode. -
            </h2>
        </>;
        hubModalContent.value = () => {
            let index = gameModeArray.indexOf(selectedGameMode.value);
            let prev = gameModeArray[(index + gameModeArray.length - 1) % gameModeArray.length];
            let next = gameModeArray[(index + 1) % gameModeArray.length];
            return <>
                <div class="game-mode-holder">
                    <button class="feature game-mode-card prev" onClick={() => selectedGameMode.value = prev}>
                        <h2>{gameModes[prev].name}</h2><hr/>
                        <i>
                            {gameModes[prev].description}<br/>
                            {format(gameModes[prev].multiplier, 1)}× XP gain.
                        </i>
                        <hr/>
                        Highest cycle reached:<br/>
                        <h1>{formatWhole(bestCycle[prev].value)}</h1>
                    </button>
                    <button class="feature game-mode-card">
                        <h2>{gameModes[selectedGameMode.value].name}</h2><hr/>
                        <i>
                            {gameModes[selectedGameMode.value].description}<br/>
                            {format(gameModes[selectedGameMode.value].multiplier, 1)}× XP gain.
                        </i>
                        <hr/>
                        Highest cycle reached:<br/>
                        <h1>{formatWhole(bestCycle[selectedGameMode.value].value)}</h1>
                    </button>
                    <button class="feature game-mode-card next" onClick={() => selectedGameMode.value = next}>
                        <h2>{gameModes[next].name}</h2><hr/>
                        <i>
                            {gameModes[next].description}<br/>
                            {format(gameModes[next].multiplier, 1)}× XP gain.
                        </i>
                        <hr/>
                        Highest cycle reached:<br/>
                        <h1>{formatWhole(bestCycle[next].value)}</h1>
                    </button>
                </div>
            </>
        };
        hubModalFooter.value = (
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Back
                </button>
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        showEquipModal()
                    }}
                >
                    Next
                </button>
            </div>
        )
        hubModalOpen.value = true;
    }
    
    function showEquipModal() {
        let slots = Decimal.add(upgrades.maxBuildings.amount.value, 6).toNumber();
        let maxCost = Decimal.mul(upgrades.startEnergy.amount.value, 25).add(100).toNumber();
        hubModalHeader.value = () => <>
            <h1 class="result-title">NEW GAME</h1>
            <h2 style="font-style: italic;">
                - Equip your buildings. -
            </h2>
            <div class="building-list collection" style="flex-wrap: nowrap; overflow-x: auto; width: 100%; margin-bottom: 20px; transition: none">
                {
                    selectedBuildings.value.map((id) => {
                        let building = buildings[id];
                        return <button 
                            class={Object.fromEntries([
                                [building.class, true],
                                ["selected", focusedBuilding.value == id],
                            ])}
                            onClick={() => {
                                if (focusedBuilding.value == id) {
                                    selectedBuildings.value.splice(selectedBuildings.value.indexOf(id), 1);
                                } else {
                                    focusedBuilding.value = id
                                }
                            }}
                        >
                            <div class="background"
                                style={{
                                    background: building.color
                                }}
                            >
                                <div class="icon">
                                    {building.icon}
                                </div>
                            </div>
                        </button>
                    })
                }{
                    [...Array(slots - selectedBuildings.value.length).keys()].map(() => <button class="disabled">a</button>)
                }
            </div>
            <hr style="background: var(--foreground); opacity: 1" />
        </>;
        hubModalContent.value = () => {
            return <>
                <div class="building-list collection" style="transition: none">
                    {
                        Object.keys(unlockedBuildings.value).map((id) => {
                            let building = buildings[id];
                            return <button 
                                class={Object.fromEntries([
                                    [building.class, true],
                                    ["disabled", selectedBuildings.value.includes(id)],
                                    ["selected", focusedBuilding.value == id],
                                ])}
                                onClick={() => {
                                    if (focusedBuilding.value == id) {
                                        if (selectedBuildings.value.includes(id)) {
                                            selectedBuildings.value.splice(selectedBuildings.value.indexOf(id), 1);
                                        } else if (selectedBuildings.value.length < slots) {
                                            selectedBuildings.value.push(id);
                                        }
                                    } else {
                                        focusedBuilding.value = id
                                    }
                                }}
                            >
                                <div class="background"
                                    style={{
                                        background: building.color
                                    }}
                                >
                                    <div class="icon">
                                        {building.icon}
                                    </div>
                                </div>
                            </button>
                        })
                    }
                </div>
            </>
        };
        hubModalFooter.value = () => <>
            {focusedBuilding.value ? <div style="display: flex; flex-direction: row; align-content: flex-start; gap: 10px; font-size: 12px; transition: none">
                <div style="flex: 0 0 calc(50% - 5px); margin: 0">
                    <h3>{buildings[focusedBuilding.value].name}</h3>{" "}
                    <h5 style="display: inline-block; margin: 0"><i>- {buildings[focusedBuilding.value].class.toUpperCase()}</i></h5>
                    <br />
                    <i>{buildings[focusedBuilding.value].description}</i>
                </div>
                <div style="flex: 0 0 calc(50% - 5px); margin: 0">
                    <h5>BASE BUILDING COST:</h5>
                    <div class="stat-entries">
                        {Object.entries(buildings[focusedBuilding.value].baseCost).map(([id, cost]) => 
                            <div>
                                <div class="name">{gameLayer.resources[id].displayName}</div>
                                <div class="value">{formatWhole(cost)}</div>
                            </div>
                        )}  
                    </div>
                    <hr style="opacity: 0; margin: 3px" />
                    <h5>STARTING SPECS:</h5>
                    <div class="stat-entries">
                        {Object.entries(buildings[focusedBuilding.value].upgrades).map(([id, upg]) => 
                            <div>
                                <div class="name">{upg.name}</div>
                                <div class="value">{format(upg.effect(0), upg.precision ?? 0) + (upg.unit ?? "")}</div>
                            </div>
                        )}
                    </div>
                </div>
            </div> : <div style="text-align: center; font-style: italic;">
                Click on a building to view its details.
            </div>}
            <hr style="opacity: 0; margin: 3px" />
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <button
                    class="feature can"
                    onClick={() => {
                        showGameModal();
                    }}
                >
                    Back
                </button>
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Close
                </button>
                <div style="flex-grow: 1" />
                {
                    selectedBuildings.value.findIndex(x => buildings[x].class == "damager" 
                        && Object.keys(buildings[x].baseCost).length <= 1
                        && (buildings[x].baseCost.energy ?? Infinity) <= maxCost
                        && buildings[x].onUpdate) >= 0
                        ? <button
                            class="feature can"
                            onClick={() => {
                                hubModalOpen.value = false;
                                outtro(1500);
                                hubState.value = HubState.Transitioning;
                                setTimeout(() => {
                                    player.tabs = ["game"];
                                    gameLayer.startGame();
                                    gameLayer.intro(2000);
                                    hubState.value = HubState.Idle;
                                }, 2000);
                            }}
                        >
                            Start game
                        </button>
                        : <div>
                            Need at least 1 building that can defeat enemies at start.
                        </div>
                }
            </div>
        </>
        focusedBuilding.value = "";
        hubModalOpen.value = true;
    }
    
    function showCollectionModal() {
        hubModalHeader.value = <>
            <h1 class="result-title">COLLECTION</h1>
            <h2 style="font-style: italic;">
                - View your unlocked buildings. -
            </h2>
        </>;
        hubModalContent.value = () => {
            let cost = 0
            return !unlocks.collection.value ? <div style="text-align: center; --layer-color: #afcfef">
                <button 
                    class={{
                        "feature": true,
                        "can": points.value >= cost
                    }}
                    style="font-size: 10px; width: 200px; height: 80px; margin: 2s0px;"
                    onClick={() => {
                        if (points.value >= cost) {
                            points.value -= cost;
                            unlocks.collection.value = true;
                        }
                    }}
                >
                    <h2>Unlock Collection.</h2>
                    <br/><br/>
                    Costs: {formatWhole(cost)} xp
                </button>
            </div> : <div class="building-list collection">
                {
                    Object.entries(buildings).map(([id, building]) => {
                        return <button 
                            class={Object.fromEntries([
                                [building.class, true],
                                ["disabled", !unlockedBuildings.value[id]],
                                ["selected", focusedBuilding.value == id],
                            ])}
                            onClick={() => focusedBuilding.value = id}
                        >
                            <div class="background"
                                style={{
                                    background: building.color
                                }}
                            >
                                <div class="icon">
                                    {building.icon}
                                </div>
                            </div>
                        </button>
                    })
                }
            </div>
        };
        hubModalFooter.value = () => <>
            {focusedBuilding.value ? <div style="display: flex; flex-direction: row; align-content: flex-start; gap: 10px; font-size: 12px; transition: none; --layer-color: #afcfef">
                <div style="flex: 0 0 calc(50% - 5px); margin: 0">
                    <h3>{buildings[focusedBuilding.value].name}</h3>{" "}
                    <h5 style="display: inline-block; margin: 0"><i>- {buildings[focusedBuilding.value].class.toUpperCase()}</i></h5>
                    <br />
                    <i>{buildings[focusedBuilding.value].description}</i>
                    <br />
                    {buildingUpgrades[focusedBuilding.value] ? <div>
                    <button class="feature can" onClick={() => {
                        showBuildingModal(focusedBuilding.value);
                    }}>
                        <h3>Enhancements</h3>
                    </button>
                    </div> : ""}
                </div>
                <div style="flex: 0 0 calc(50% - 5px); margin: 0">
                    <h5>BASE BUILDING COST:</h5>
                    <div class="stat-entries">
                        {Object.entries(buildings[focusedBuilding.value].baseCost).map(([id, cost]) => 
                            <div>
                                <div class="name">{gameLayer.resources[id].displayName}</div>
                                <div class="value">{formatWhole(cost)}</div>
                            </div>
                        )}  
                    </div>
                    <hr style="opacity: 0; margin: 3px" />
                    <h5>STARTING SPECS:</h5>
                    <div class="stat-entries">
                        {Object.entries(buildings[focusedBuilding.value].upgrades).map(([id, upg]) => 
                            <div>
                                <div class="name">{upg.name}</div>
                                <div class="value">{format(upg.effect(0), upg.precision ?? 0) + (upg.unit ?? "")}</div>
                            </div>
                        )}
                    </div>
                </div>
            </div> : unlocks.collection.value ? <div style="text-align: center; font-style: italic;">
                Click on a building to view its details.
            </div> : ""}
            <hr style="opacity: 0; margin: 3px" />
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Back
                </button>
            </div>
        </>
        focusedBuilding.value = "";
        hubModalOpen.value = true;
    }
    
    function showResearchModal() {
        hubModalHeader.value = <>
            <h1 class="result-title">LABORATORY</h1>
            <h2 style="font-style: italic;">
                - Replay. Research. Repeat. -
            </h2>
        </>;
        hubModalContent.value = () => {
            let cost = 250
            return !unlocks.research.value ? <div style="text-align: center; --layer-color: #afcfef">
                <button 
                    class={{
                        "feature": true,
                        "can": points.value >= cost
                    }}
                    style="font-size: 10px; width: 200px; height: 80px; margin: 20px;"
                    onClick={() => {
                        if (points.value >= cost) {
                            points.value -= cost;
                            unlocks.research.value = true;
                        }
                    }}
                >
                    <h2>Unlock Research.</h2>
                    <br/><br/>
                    Costs: {formatWhole(cost)} xp
                </button>
            </div> : <div style="text-align: center; --layer-color: #afcfef">
                You have <h2>{formatWhole(points.value)}</h2> xp.
                <br/><br/>
                <div style="display: flex; flex-wrap: wrap; justify-content: center">
                    {Object.values(upgrades).map(render)}
                </div>
                <br/><br/>
            </div>
        };
        hubModalFooter.value = (
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Back
                </button>
            </div>
        )
        hubModalOpen.value = true;
    }
        
    function showObjectivesModal() {
        hubModalHeader.value = () => <>
            <h1 class="result-title">OBJECTIVES</h1>
            <h2 style="font-style: italic;">
                - Do tasks. Reap rewards. -
            </h2>
            {unlocks.objectives.value ? <div class="option-tabs">
                <button 
                    class={{selected: objectiveViewMode.value == 'normal'}} 
                    onClick={() => objectiveViewMode.value = 'normal'}
                >
                    Normal
                </button>
                <button 
                    class={{selected: objectiveViewMode.value == 'special'}} 
                    onClick={() => objectiveViewMode.value = 'special'}
                >
                    Special
                </button>
            </div> : ""}
        </>;
        hubModalContent.value = () => {
            let cost = 0
            return !unlocks.objectives.value ? <div style="text-align: center; --layer-color: #afcfef">
                <button 
                    class={{
                        "feature": true,
                        "can": points.value >= cost
                    }}
                    style="font-size: 10px; width: 200px; height: 80px; margin: 20px;"
                    onClick={() => {
                        if (points.value >= cost) {
                            points.value -= cost;
                            unlocks.objectives.value = true;
                        }
                    }}
                >
                    <h2>Unlock Objectives.</h2>
                    <br/><br/>
                    Costs: {formatWhole(cost)} xp
                </button>
            </div> : <div style="text-align: center; --layer-color: #afcfef">
                {
                    objectiveViewMode.value == "special" ? Object.entries(specialObjectives).map(([id, obj]) => {
                        let done = objectives.value[id];
                        return <div class="objective-holder">
                            <h3>{obj.name}</h3><br/>
                            {
                                done === undefined ? obj.description.replaceAll(/\S/g, "?") :
                                obj.description
                            }
                            <hr/>
                            <div class="building-list" style="justify-content: center; margin-top: 0; transition: none">
                                <button 
                                    class={Object.fromEntries([
                                        ... obj.reward[0] == "building" ? [[buildings[obj.reward[1]].class, true]] : [],
                                        ["disabled", done === 1],
                                        ["claimable", done === 0],
                                    ])}
                                    onClick={() => {
                                        if (done === 0) {
                                            if (obj.reward[0] == "building") {
                                                unlockedBuildings.value[obj.reward[1]] = true;
                                            }
                                            done = objectives.value[id] = 1;
                                        }
                                    }}
                                >
                                    <div class="background"
                                            style={{
                                                background: buildings[obj.reward[1]].color
                                            }}
                                        >
                                        <div class="icon">
                                            {buildings[obj.reward[1]].icon}
                                        </div>
                                    </div>
                                </button>
                            </div>
                        </div>
                    }) : Object.entries(normalObjectives).map(([id, obj]) => {
                        let level = objectives.value[id] ?? 0;
                        let goal = obj.goal(level);
                        return <div class="objective-holder">
                            <h3>{obj.name}</h3><br/>
                            {obj.description.replace("{0}", format(goal, obj.goalPrecision ?? 0))}
                            <hr/>
                            <div style="display: inline-block; min-width: 50px; padding-inline: 5px; border-bottom: 2px solid var(--foreground); transition: none">
                                {format(obj.target.value, obj.goalPrecision ?? 0)}
                            </div>
                            <div class="building-list">
                                {
                                    [-3, -2, -1, 0, 1, 2, 3].map(ofs => {
                                        let exc = obj.exclusiveRewards[level + ofs];
                                        let rew = obj.reward(level + ofs);
                                        return <button 
                                            class={Object.fromEntries([
                                                ... exc?.[0] == "building" ? [[buildings[exc[1]].class, true]] : [],
                                                ["disabled", ofs < 0],
                                                ["claimable", ofs >= 0 && obj.target.value >= obj.goal(level + ofs)],
                                            ])}
                                            onClick={() => {
                                                if (ofs >= 0 && obj.target.value >= obj.goal(level + ofs)) {
                                                    for (let c = 0; c <= ofs; c++) {
                                                        let exc = obj.exclusiveRewards[level];
                                                        if (exc) {
                                                            if (exc[0] == "building") {
                                                                unlockedBuildings.value[exc[1]] = true;
                                                            }
                                                        } else {
                                                            let rew = obj.reward(level);
                                                            let target = ({
                                                                xp: points,
                                                                capsules: capsules,
                                                            })[rew[0]];
                                                            target.value = Decimal.add(target.value, rew[1]).toNumber()
                                                        }
                                                        level = objectives.value[id] = level + 1;
                                                    }
                                                }
                                            }}
                                        >
                                            <div class={{goal: true, zero: ofs == 0}}>
                                                {level + ofs >= 0 ? format(obj.goal(level + ofs), obj.goalPrecision ?? 0) : ""}
                                            </div>
                                            {
                                                level + ofs < 0 ? "" : !exc ? <div class="xp-reward">
                                                    {format(rew[1], obj.rewardPrecision ?? 0)}<br/>
                                                    {({
                                                        xp: "XP",
                                                        capsules: "💊",
                                                    })[rew[0]]}
                                                </div> : <div class="background"
                                                    style={{
                                                        background: buildings[exc[1]].color
                                                    }}
                                                >
                                                    <div class="icon">
                                                        {buildings[exc[1]].icon}
                                                    </div>
                                                </div>
                                            }
                                        </button>
                                    })
                                }
                            </div>
                        </div>
                    })
                }
            </div>
        };
        hubModalFooter.value = (
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Back
                </button>
            </div>
        )
        hubModalOpen.value = true;
    }
    
    function showCapsuleModal() {
        hubModalHeader.value = <>
            <h1 class="result-title">CAPSULES</h1>
            <h2 style="font-style: italic;">
                - The solution to everything. -
            </h2>
        </>;
        hubModalContent.value = () => {
            let cost = 1;
            let interval = 900 / (100 + getCapsuleEffect("capsules")) / (100 + new Decimal(upgrades.capsuleGain.amount.value).toNumber()) * 10000;
            let capacity = 20 + getCapsuleEffect("capacity") + new Decimal(upgrades.capsuleCap.amount.value).toNumber();
            let amount = Math.min((player.time - timeSinceLastClaim.value) / interval / 1000, capacity);
            return !unlocks.capsules.value ? <div style="text-align: center; --layer-color: #afcfef">
                <button 
                    class={{
                        "feature": true,
                        "can": capsules.value >= cost
                    }}
                    style="font-size: 10px; width: 200px; height: 80px; margin: 20px;"
                    onClick={() => {
                        if (capsules.value >= cost) {
                            capsules.value -= cost;
                            unlocks.capsules.value = true;
                        }
                    }}
                >
                    <h2>Unlock Capsules.</h2>
                    <br/><br/>
                    Costs: {formatWhole(cost)} 💊
                </button>
            </div> : <div style="text-align: center; --layer-color: #afcfef">
                You have <h2>{formatWhole(capsules.value)}</h2> 💊.
                <hr/>
                {
                    Object.entries(capsuleUpgrades).map(([id, upg]) => {
                        let level = allocatedCapsules.value[id] ?? 0;
                        return <button class="feature" style="background: #afcfef; font-size: 10px; width: 240px; height: 100px;">
                            {formatWhole(level)} 💊<br/>
                            <h3>{upg.name}</h3><br/>
                            {upg.description.replace("{0}", format(upg.formula(level), upg.precision ?? 0))}
                        </button>
                    })
                }
                <hr/>
                <button 
                    class={{feature: true, can: capsules.value >= 1}} 
                    style="font-size: 12px; width: 240px; height: 50px;"
                    onClick={() => {
                        if (capsules.value >= 1) {
                            capsules.value -= 1;
                            let list = Object.keys(capsuleUpgrades);
                            let sel = list[Math.floor(Math.random() * list.length)];
                            allocatedCapsules.value[sel] = (allocatedCapsules.value[sel] ?? 0) + 1;
                        }
                    }}>
                    Open 1 💊
                </button>
                <hr/><br/>
                You have <h2>{format(amount, 2)} / {format(capacity, 2)}</h2> unclaimed 💊.<br/>
                You gain 1 💊 every {formatTime(interval)}.<br/>
                ({amount >= capacity 
                    ? "Your 💊 is full, claim them now!" 
                    : "Full after " + formatTime((capacity - amount) * interval)
                })
                <hr/>
                <button 
                    class={{feature: true, can: amount >= 1}} 
                    style="font-size: 12px; width: 240px; height: 50px;"
                    onClick={() => {
                        let gain = Math.floor(amount);
                        capsules.value += gain;
                        amount -= gain;
                        timeSinceLastClaim.value = Date.now() - amount * interval * 1000;
                    }}>
                    Claim {formatWhole(Math.floor(amount))} 💊
                </button>
            </div>
        };
        hubModalFooter.value = (
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        hubModalOpen.value = false;
                    }}
                >
                    Back
                </button>
            </div>
        )
        hubModalOpen.value = true;
    }

    function showBuildingModal(id: string) {
        let building = buildings[id];
        hubModalHeader.value = () => <>
            <h1 class="result-title">{building.name}</h1>
            <h2 style="font-style: italic;">
                - Enhance your building. -
            </h2>
        </>;
        hubModalContent.value = () => {
            return <div style="text-align: center; --layer-color: #afcfef">
                You have <h2>{formatWhole(points.value)}</h2> xp.
                <br/><br/>
                <div style="display: flex; flex-wrap: wrap; justify-content: center">
                    {Object.values(buildingUpgrades[id]).map(render)}
                </div>
                </div>
        };
        hubModalFooter.value = (
            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                <div style="flex-grow: 1" />
                <button
                    class="feature can"
                    onClick={() => {
                        showCollectionModal();
                        focusedBuilding.value = id;
                    }}
                >
                    Back
                </button>
            </div>
        )
    }

    let hubModalOpen = ref(false);
    let hubModalHeader = ref<Computable<JSX.Element | string>>("");
    let hubModalContent = ref<Computable<JSX.Element | string>>("");
    let hubModalFooter = ref<Computable<JSX.Element | string>>("");

    return {
        name: "Tree",
        color: "#afcfef",
        classes: { "hub": true },
        minimizable: false,

        points,
        total,
        capsules,
        timeSinceLastClaim,

        intro,
        outtro,
        
        bestCycle,
        stats,

        hubState,
        selectedGameMode,

        unlockedBuildings,
        selectedBuildings,

        board,
        unlocks,
        upgrades,
        buildingUpgrades,
        objectives,
        allocatedCapsules,

        getCapsuleEffect,

        display: jsx(() => (
            <>
                {render(board)}
                <div class={{
                    "game-top": true,
                    "hidden": hubState.value == HubState.Transitioning || isAnimating.value,
                }}>
                    <div style="display: flex; height: 31px; justify-content: center">
                        <span class="bar-label" style="margin: 4px;">
                            {formatWhole(points.value)} xp
                        </span>
                        <span class="bar-label" style="margin: 4px;">
                            {formatWhole(capsules.value)} 💊
                        </span>
                    </div>
                </div>
                <ModalVue 
                    modelValue={hubModalOpen.value} 
                    onUpdate:modelValue={x => hubModalOpen.value = x}
                    v-slots={{
                        header: hubModalHeader.value,
                        body: hubModalContent.value,
                        footer: hubModalFooter.value,
                    }}
                />
            </>
        )),
    };
});

/**
 * Given a player save data object being loaded, return a list of layers that should currently be enabled.
 * If your project does not use dynamic layers, this should just return all layers.
 */
export const getInitialLayers = (
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    player: Partial<Player>
): Array<GenericLayer> => [main, gameLayer];

/**
 * A computed ref whose value is true whenever the game is over.
 */
export const hasWon = computed(() => {
    return Object.keys(main.unlockedBuildings.value).length >= Object.keys(buildings).length;
});

/**
 * Given a player save data object being loaded with a different version, update the save data object to match the structure of the current version.
 * @param oldVersion The version of the save being loaded in
 * @param player The save data being loaded in
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export function fixOldSave(
    oldVersion: string | undefined,
    player: Partial<Player>
    // eslint-disable-next-line @typescript-eslint/no-empty-function
): void {
}
/* eslint-enable @typescript-eslint/no-unused-vars */
