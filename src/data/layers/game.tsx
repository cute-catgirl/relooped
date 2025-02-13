/**
 * @module
 * @hidden
 */
import { gameModes, main } from "data/projEntry";
import { createCumulativeConversion } from "features/conversion";
import { JSXFunction, jsx } from "features/feature";
import { createHotkey } from "features/hotkey";
import { createReset } from "features/reset";
import MainDisplay from "features/resources/MainDisplay.vue";
import { Resource, createResource, trackTotal } from "features/resources/resource";
import { addTooltip } from "features/tooltips/tooltip";
import { createResourceTooltip } from "features/trees/tree";
import { BaseLayer, createLayer } from "game/layers";
import { DecimalSource, format, formatTime } from "util/bignum";
import { render } from "util/vue";
import { createLayerTreeNode, createResetButton } from "../common";
import { BoardNode, BoardNodeLink, GenericBoard, createBoard } from "features/boards/board";
import { noPersist, persistent } from "game/persistence";
import { BoardConnections, BoardID, Building, BuildingType, Enemy, Loop } from "../types/data";
import { CSSProperties, StyleValue, computed, nextTick, ref, unref } from "vue";
import * as types from "../types/board";
import player from "game/player";
import { globalBus } from "game/events";
import Decimal, { formatWhole } from "util/break_eternity";
import { createBar } from "features/bars/bar";
import { Direction } from "util/common";
import * as b from "../types/buildings";
import "components/common/features.css";
import vuePlugin from "@vitejs/plugin-vue";
import ModalVue from "components/Modal.vue";
import { GenericRepeatable, createRepeatable } from "features/repeatable";
import Formula from "game/formulas/formulas";
import { createCostRequirement, displayRequirements } from "game/requirements";
import settings from "game/settings";

const buildings = b as { [key: string]: BuildingType };

const id = "game";

function loopIdToPosition(id: string) {
    let [x, y] = id.split("x");
    return { x: +x, y: +y };
}

function loopPositionToId(x: number, y: number) {
    return x + "x" + y;
}

let building: Building | undefined = undefined;

enum GameState {
    New = "",
    Started = "start",
    Stopped = "stop",
    Idle = "idle",
}

const layer = createLayer(id, function (this: BaseLayer) {
    const name = "Game";

    const cycle = persistent<number>(0);
    const cycleProgress = persistent<number>(0);
    const health = persistent<number>(0);
    const stress = ref<number>(0);

    const loops = persistent<Record<string, Loop>>({});

    const lifetime = persistent<number>(0);
    const resources = {
        energy: createResource<number>(0, "Energy"),
        info: createResource<number>(0, "Info"),
    } as { [key: string]: Resource<number>};
    const resourcesTotal = Object.fromEntries(Object.entries(resources).map(([id, res]) => [id, trackTotal(res)]));

    const buildingFactor = persistent<number>(0);
    const buildingFactors = persistent<{ [key: string]: number }>({});

    function getBuildingCostFactor(building: string) {
        return 1.1 ** (buildingFactor.value + (buildingFactors.value[building] ?? 0));
    }

    function getBuildingCostReduction(building: string) {
        if (building === "beamer") {
            if (main.buildingUpgrades.beamer.cost.bought.value == true) {
                return 5;
            }
        }
        return 0;
    }

    const gameState = persistent<string>("", false);
    const gameSpeed = persistent<number>(0);
    const gamePaused = ref<boolean>(false);
    const gameStucked = ref<boolean>(false);
    
    const sellCooldown = persistent<number>(0);
    
    const xpWorth = ref<number>(0);
    
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

    const upgrades = {
        stress: createRepeatable(self => ({
            display: jsx(() => <>
                Level {formatWhole(self.amount.value)}<br/>
                <h3>Stress Tolerance</h3>
                <hr/>
                &uarr; {formatWhole(Decimal.add(self.amount.value, 101))}% &uarr;<br/>
                {formatWhole(Decimal.add(self.amount.value, 100))}%<br/>
                <hr/>
                {displayRequirements(upgrades.stress.requirements)}
            </>),
            requirements: createCostRequirement(() => ({
                resource: noPersist(resources.info),
                cost: Formula.variable(self.amount).pow_base(1.1).mul(50),
            })),
        })),
        energy: createRepeatable(self => ({
            display: jsx(() => <>
                Level {formatWhole(self.amount.value)}<br/>
                <h3>Enemy Base Energy</h3>
                <hr/>
                &uarr; {formatWhole(Decimal.add(self.amount.value, 26))} &uarr;<br/>
                {formatWhole(Decimal.add(self.amount.value, 25))}<br/>
                <hr/>
                {displayRequirements(upgrades.energy.requirements)}
            </>),
            requirements: createCostRequirement(() => ({
                resource: noPersist(resources.info),
                cost: Formula.variable(self.amount).pow_base(1.15).mul(50),
            })),
        })),
    } as Record<string, GenericRepeatable>;

    function startGame() {
        cycle.value = 0;
        cycleProgress.value = 0;
        resources.energy.value = Decimal.mul(main.upgrades.startEnergy.amount.value, 25)
            .add(main.getCapsuleEffect("energy")).add(100).toNumber();
        resources.info.value = Decimal.mul(main.upgrades.startInfo.amount.value, 50)
            .toNumber();
        nextTick(() => {
            resourcesTotal.energy.value = 0;
            resourcesTotal.info.value = resources.info.value;
        })
        console.log(resources.info.value);
        buildingFactor.value = 0;
        buildingFactors.value = {};
        lifetime.value = 0;

        gameState.value = GameState.Started;
        gameSpeed.value = 1;
        gameStucked.value = false;

        for (let upg of Object.values(upgrades)) {
            upg.amount.value = 0;
        }

        sellCooldown.value = 0;

        health.value = 100;
        
        let timeout = () => setTimeout(() => {
            if (board.stage.value) {
                let transform = board.stage.value.getTransform();
                board.stage.value.zoomAbs(window.innerWidth / 2, window.innerHeight / 2, 1);
                board.stage.value.moveTo(window.innerWidth / 2, window.innerHeight / 2);
            } else {
                timeout();
            }
        }, 0);
        timeout();

        loops.value = { "0x0": { enemies: [
            {
                angle: 0,
                lifetime: 0,
                speed: Number.EPSILON,
                health: 20,
                maxHealth: 20,
                effects: {},
                loot: { energy: 100 },
            }
        ] } };
    }

    function endGame(breakTime = 3000, endTime = 6000) {
        gameState.value = GameState.Stopped;
        gameSpeed.value = 0.1;

        main.bestCycle[main.selectedGameMode.value].value = Math.max(
            main.bestCycle[main.selectedGameMode.value].value,
            cycle.value
        )

        let minPos = { x: 0, y: 0 };
        let maxPos = { x: 0, y: 0 };
        for (let id in loops.value) {
            let {x, y} = loopIdToPosition(id);
            minPos.x = Math.min(minPos.x, x); minPos.y = Math.min(minPos.y, y);
            maxPos.x = Math.max(maxPos.x, x); maxPos.y = Math.max(maxPos.y, y);
        }
        let moveX = (minPos.x + maxPos.x) * -50;
        let moveY = (minPos.y + maxPos.y) * -50;
        let zoomLevel = Math.min(
            (window.innerWidth) / (maxPos.x - minPos.x + 1) / 120,
            (window.innerHeight) / (maxPos.y - minPos.y + 1) / 120,
            1
        );
        let timeout = () => setTimeout(() => {
            if (board.stage.value) {
                board.stage.value.smoothMoveTo(moveX + window.innerWidth / 2, moveY + window.innerHeight / 2);
                board.stage.value.smoothZoomAbs(window.innerWidth / 2, window.innerHeight / 2, zoomLevel);
            } else {
                timeout();
            }
        }, 0);
        timeout();
        
        xpWorth.value = 
            Math.sqrt(cycle.value) * Math.sqrt(lifetime.value / 60) * (1 + main.getCapsuleEffect("xp") / 100)
            * Object.values(resourcesTotal).reduce((x, y) => x + Math.log10(new Decimal(y.value).toNumber() + 1), 1);

        xpWorth.value *= gameModes[main.selectedGameMode.value].multiplier;

        setTimeout(() => {
            for (let node of unref(board.state).nodes) {
                (node.state as { velocity?: { x: number, y: number } }).velocity = { 
                    x: Math.random() * 450 - 225,
                    y: Math.random() * -450,
                }
            }
        }, breakTime);

        if (endTime) setTimeout(() => {
            endGameModalShown.value = true;
        }, endTime);
    }

    function spawnEnemies() {

        let count = 1 + (0.1 * cycle.value) + (0.01 * cycle.value * Math.min(cycle.value, 40));
        count = Math.floor(count) + (Math.random() < (count % 1) ? 1 : 0);
        let loopList = Object.values(loops.value);
        if (loopList.length <= 0) return;
        
        let enemyFactor: number = 1;
        switch (main.selectedGameMode.value) {
            case "standard":
                enemyFactor = 1;
                break;
            case "boosted":
                enemyFactor = 1.5;
                break;
            case "hardcore":
                enemyFactor = 2;
                break;
        }

        for (let a = 0; a < count; a++) {
            let health = 18 * (1 + 0.05 * (cycle.value * enemyFactor) ** enemyFactor) * 1.02 ** cycle.value * (Math.random() * .2 + .9);
            console.log("Initial:", health);
            health *= (1 - main.getCapsuleEffect("health") / 100);
            console.log("After capsules:", health)
            loopList[Math.floor(Math.random() * loopList.length)].enemies.push({
                angle: Math.random(),
                lifetime: 0,
                speed: (Math.random() * .4 + .8 + 0.05 * cycle.value * enemyFactor) * (Math.random() < .5 ? 1 : -1),
                health,
                maxHealth: health,
                effects: {},
                loot: { energy: Decimal.add(25, upgrades.energy.amount.value).toNumber() },
            });
        }
    }
    
    function getInfluence(id: string) {
        let { x, y } = loopIdToPosition(id);

        let flu: Record<string, number> = {};

        for (let [ dx, dy ] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let loop = loops.value[loopPositionToId(x + dx, y + dy)];
            let f = null;
            if (loop?.building && (f = buildings[loop.building.type].influences?.(loop.building, loop))) {
                for (let attr in f) {
                    flu[attr] = (flu[attr] ?? 1) * f[attr];
                }
            }
        }
        
        return flu;
    }

    function spawnLoop() {
        let entries = Object.entries(loops.value);
        let id = "";

        while (entries.length) {
            let pos = Math.floor(Math.random() * entries.length);
            let entry = entries[pos];
            let { x: ex, y: ey } = loopIdToPosition(entry[0]);
            let poses = [];

            if (!loops.value[loopPositionToId(ex + 1, ey)]) poses.push(loopPositionToId(ex + 1, ey));
            if (!loops.value[loopPositionToId(ex - 1, ey)]) poses.push(loopPositionToId(ex - 1, ey));
            if (!loops.value[loopPositionToId(ex, ey + 1)]) poses.push(loopPositionToId(ex, ey + 1));
            if (!loops.value[loopPositionToId(ex, ey - 1)]) poses.push(loopPositionToId(ex, ey - 1));

            if (poses.length) {
                id = poses[Math.floor(Math.random() * poses.length)];
                break;
            } else {
                entries.splice(pos, 1);
            }
        }
        
        loops.value[id] = { enemies: [] };
    }

    globalBus.on("onLoad", () => {
        if (gameState.value == GameState.New) {
            startGame();
            intro(3000);
        } else if (gameState.value == GameState.Stopped) {
            endGame();
        }
    })

    globalBus.on("update", delta => {
        if (gameState.value == GameState.Started) {
            if (gameSpeed.value <= 0 || gamePaused.value) return;
            delta *= gameSpeed.value;
            lifetime.value += delta;
            sellCooldown.value -= delta;
    
            if (cycle.value >= 1) {
                cycleProgress.value += delta / (15 + Math.sqrt(cycle.value));
                if (cycleProgress.value >= 1) {
                    cycleProgress.value--;
                    cycle.value++;
                    spawnEnemies();
                    if ((cycle.value + 1) % 2 == 0) spawnLoop();
                }
            }
            let hasEnemies = false;
            let isStucked = true;
            for (let loop of Object.values(loops.value)) {
                hasEnemies ||= loop.enemies.length > 0;
                isStucked &&= !loop.building;
            }
            if (!hasEnemies) {
                cycleProgress.value = 0;
                cycle.value++;
                spawnEnemies();
                if ((cycle.value + 1) % 2 == 0) spawnLoop();
            }
            if (isStucked && !gameStucked.value) {
                for (let b of main.selectedBuildings.value) {
                    if (buildings[b].class == "damager" && canAffordBuilding(b)) {
                        isStucked = false;
                        break;
                    }
                }
                if (isStucked) {
                    main.objectives.value.stucked = main.objectives.value.stucked ?? 0;
                    gameStucked.value = true;
                    setTimeout(() => {
                        gamePaused.value = false;
                        endGame();
                    }, 3000);
                }
            }
            if (Math.floor(resources.energy.value) == 727) {
                main.objectives.value.wysi = main.objectives.value.wysi ?? 0;
            }
    
            let enemyMoves: {
                enemy: Enemy;
                from: string;
                to: string;
            }[] = [];
    
            stress.value = 0;
    
            for (let id in loops.value) {
                let loop = loops.value[id];
                let { x, y } = loopIdToPosition(id);
    
                for (let enm of loop.enemies) {
                    let prevAngle = enm.angle;

                    let dist = enm.speed * 0.1 * delta;
                    if (enm.effects.stun) dist *= 0.0005;
                    if (enm.effects.freeze) dist *= 0.5;
                    if (enm.effects.swamped) dist *= 0.5;
                    if (enm.effects.blaze) dist *= 2;
                    enm.angle += dist;
                    enm.lifetime += Math.abs(dist);

                    stress.value += enm.lifetime;
                    enm.angle = ((enm.angle % 1) + 1) % 1;
        
                    let [ min, max ] = [
                        Math.min(prevAngle, enm.angle),
                        Math.max(prevAngle, enm.angle),
                    ];
    
                    if (enm.health <= 0) {
                        loop.enemies.splice(loop.enemies.indexOf(enm), 1);
                        for (let [id, loot] of Object.entries(enm.loot)) {
                            resources[id].value = Decimal.add(resources[id].value, loot).toNumber();
                        }
                    }
        
                    // Bottom (+y)
                    if (min < .25 && max > .75) {
                        if (loops.value[loopPositionToId(x, y + 1)] && Math.random() < 0.5) {
                            enemyMoves.push({
                                enemy: enm,
                                from: loopPositionToId(x, y),
                                to: loopPositionToId(x, y + 1),
                            });
                            enm.angle = 0.5 - enm.angle;
                            enm.speed = -enm.speed;
                        }
                    }
                    // Right (+x)
                    else if (min < .25 && max > .25) {
                        if (loops.value[loopPositionToId(x + 1, y)] && Math.random() < 0.5) {
                            enemyMoves.push({
                                enemy: enm,
                                from: loopPositionToId(x, y),
                                to: loopPositionToId(x + 1, y),
                            });
                            enm.angle = 1 - enm.angle;
                            enm.speed = -enm.speed;
                        }
                    }
                    // Top (-y)
                    else if (min < .5 && max > .5) {
                        if (loops.value[loopPositionToId(x, y - 1)] && Math.random() < 0.5) {
                            enemyMoves.push({
                                enemy: enm,
                                from: loopPositionToId(x, y),
                                to: loopPositionToId(x, y - 1),
                            });
                            enm.angle = 0.5 - enm.angle;;
                            enm.speed = -enm.speed;
                        }
                    }
                    // Left (-x)
                    else if (min < .75 && max > .75) {
                        if (loops.value[loopPositionToId(x - 1, y)] && Math.random() < 0.5) {
                            enemyMoves.push({
                                enemy: enm,
                                from: loopPositionToId(x, y),
                                to: loopPositionToId(x - 1, y),
                            });
                            enm.angle = 1 - enm.angle;
                            enm.speed = -enm.speed;
                        }
                    }
                    
                    enm.angle = ((enm.angle % 1) + 1) % 1;
                    
                    for (let eff in enm.effects) {
                        enm.effects[eff] -= Math.abs(dist);
                        if (enm.effects[eff] <= 0) delete enm.effects[eff];
                    }
                    if (enm[BoardConnections]) {
                        for (let from in enm[BoardConnections]) {
                            enm[BoardConnections][from] -= delta;
                        }
                    }
                }
    
                if (loop.building) {
                    buildings[loop.building.type].onUpdate?.(loop.building, loop, delta, getInfluence(id));
                }
            }
    
            stress.value /= Object.values(loops.value).length * 10 * Decimal.div(upgrades.stress.amount.value, 100).add(1).toNumber();
    
            if (stress.value > 1) {
                let healthFactor = 1;
                switch (main.selectedGameMode.value) {
                    case "standard":
                        healthFactor = 1;
                        break;
                    case "boosted":
                        healthFactor = 2;
                        break;
                    case "hardcore":
                        healthFactor = 10;
                        break;
                }
                health.value -= (2 ** stress.value) * delta * healthFactor;
            }
            if (stress.value >= 2) {
                main.objectives.value.anxiety = main.objectives.value.anxiety ?? 0;
            }
            if (health.value <= 0) {
                endGame();
            }
            
            for (let move of enemyMoves) {
                let from = loops.value[move.from];
                let to = loops.value[move.to];

                from.enemies.splice(from.enemies.indexOf(move.enemy), 1);
                to.enemies.push(move.enemy);
    
                if (from.building) {
                    buildings[from.building.type].onEnemyExit?.(from.building, from, move.enemy, getInfluence(move.from));
                }
                if (to.building) {
                    buildings[to.building.type].onEnemyEnter?.(to.building, to, move.enemy, getInfluence(move.to));
                }
            }
    
            if (selectedBuilding.value) {
                if (canAffordBuilding(selectedBuilding.value)) {
                    if (board.selectedNode.value?.type == "loop") {
                        let loop = (board.selectedNode.value.state as { target: Loop }).target;
                        if (loop.building) {
                            unref(board.state).selectedNode = null;
                        } else {
                            loop.building = {
                                type: selectedBuilding.value,
                                upgrades: {},
                                data: {},
                                sellValue: {},
                            }
                            for (let [id, cost] of Object.entries(buildings[selectedBuilding.value].baseCost)) {
                                let realCost = (cost - getBuildingCostReduction(selectedBuilding.value)) * getBuildingCostFactor(selectedBuilding.value);
                                resources[id].value -= realCost;
                                loop.building.sellValue[id] = realCost * 0.75;
                            }
                            let id = Object.entries(loops.value).find(x => x[1] == loop)?.[0];
                            if (id) for (let enm of loop.enemies) {
                                buildings[selectedBuilding.value].onEnemyEnter?.(loop.building as Building, loop, enm, getInfluence(id));
                            }
                            buildingFactor.value++;
                            buildingFactors.value[selectedBuilding.value] = (buildingFactors.value[selectedBuilding.value] ?? 0) + 1;
                            selectedBuilding.value = "";
                        }
                    }
                } else {
                    selectedBuilding.value = "";
                }
            }
        } else if (gameState.value == GameState.Stopped) { 
            for (let id in loops.value) {
                for (let enm of loops.value[id].enemies) {
                    enm.angle += 0.001 * delta;
                }
            }
            for (let node of unref(board.state).nodes) {
                let state = node.state as { velocity?: { x: number, y: number } };
                if (state.velocity) {
                    node.position.x += state.velocity.x * delta;
                    node.position.y += state.velocity.y * delta;
                    state.velocity.y += 250 * delta;
                } else {
                    node.position.x += (Math.random() * 2 - 1);
                    node.position.y += (Math.random() * 2 - 1);
                }
            }
        }
    });

    let newBoardID = 0;

    const board = createBoard(() => ({
        startNodes: () => [],
        state() {
            let nodes: BoardNode[] = [];

            {
                let enemies: (Enemy & { position: {x: number, y: number }})[] = [];
    
                for (let [lid, loop] of Object.entries(loops.value)) {
                    let {x, y} = loopIdToPosition(lid);
                    for (let enemy of loop.enemies) {
                        if (!enemy[BoardID]) {
                            enemy[BoardID] = newBoardID;
                            newBoardID += 1;
                        }
                        enemies.push({
                            ...enemy,
                            position: { x, y }
                        });
                    }
    
                    x = x * 100;
                    y = y * 100;
    
                    if (!loop[BoardID]) {
                        loop[BoardID] = newBoardID;
                        newBoardID += 2;
                    }
    
                    nodes.push({
                        id: loop[BoardID] ?? 0,
                        position: { x, y },
                        type: "loop",
                        state: { target: loop }
                    })
                    if (loop.building) {
                        nodes.push({
                            id: (loop[BoardID] ?? 0) + 1,
                            position: { x, y },
                            type: "building",
                            state: { target: loop.building }
                        })
                    }
                }
    
                
                if (settings.quality >= 1) for (let enm of enemies) {
                    let {x, y} = enm.position;
                    
                    nodes.push({
                        id: enm[BoardID] ?? 0,
                        position: { 
                            x: (x + Math.sin(enm.angle * 2 * Math.PI) * .5) * 100, 
                            y: (y + Math.cos(enm.angle * 2 * Math.PI) * .5) * 100 
                        },
                        type: "enemy",
                        state: { target: enm }
                    });
                }
            }
            
            if (gameState.value == GameState.Stopped && unref(board.state)?.nodes.length > 0) {
                let oldNodes = unref(board.state)?.nodes;
                for (let id in nodes) {
                    nodes[id].position.x = oldNodes[id]?.position.x ?? nodes[id].position.x;
                    nodes[id].position.y = oldNodes[id]?.position.y ?? nodes[id].position.y;
                    nodes[id].state = oldNodes[id]?.state ?? nodes[id].state;
                }
            }

            return {
                nodes,
                selectedNode: unref(board.state)?.selectedNode ?? null,
                selectedAction: null,
            }
        },
        links() {
            let links: BoardNodeLink[] = [];
            if (settings.quality < 2) return links;
            for (let [lid, loop] of Object.entries(loops.value)) {
                for (let enemy of loop.enemies) {
                    if (enemy[BoardConnections]) {
                        for (let from in enemy[BoardConnections]) {
                            let startNode = board.nodes.value.find(x => x.id == +from);
                            let endNode = board.nodes.value.find(x => x.id == enemy[BoardID]);
                            if (startNode && endNode) links.push({
                                startNode,
                                endNode,
                                stroke: "white",
                                strokeWidth: 2,
                            });
                            if (enemy[BoardConnections][from] <= 0) delete enemy[BoardConnections][from];
                        }
                    }
                }
            }
            return links;
        },
        classes: { "game-board": true },
        types,
    })) as GenericBoard;

    const cycleBar = createBar(() => ({
        width: 500,
        height: 31,
        direction: Direction.Right,
        progress: computed(() => cycleProgress.value),
        display: jsx(() => <span class="bar-label">
            Cycle {formatWhole(cycle.value)}
        </span>),
        fillStyle: { backgroundColor: "#50637c" },
        baseStyle: { backgroundColor: "#0000001f" },
        borderStyle: { 
            border: "none", 
            borderTop: "2px solid var(--outline)",
            borderRadius: "0 0 0 4px",
        }
    }));

    const stressBar = createBar(() => ({
        width: 249,
        height: 31,
        direction: Direction.Right,
        progress: computed(() => stress.value),
        display: jsx(() => <span class="bar-label left">
            Stress: {formatWhole(stress.value * 100)}%
        </span>),
        fillStyle: { backgroundColor: "#ff5c5a" },
        baseStyle: { backgroundColor: "#0000001f" },
        borderStyle: { 
            border: "none", 
            borderTop: "2px solid var(--outline)", 
            borderRadius: "0 0 0 4px",
        }
    }));

    const healthBar = createBar(() => ({
        width: 249,
        height: 31,
        direction: Direction.Left,
        progress: computed(() => health.value / 100),
        display: jsx(() => <span class="bar-label right">
            HP: {formatWhole(health.value)}%
        </span>),
        fillStyle: { backgroundColor: "#ff5c5a" },
        baseStyle: { backgroundColor: "#0000001f" },
        borderStyle: { 
            border: "none", 
            borderTop: "2px solid var(--outline)", 
            borderLeft: "2px solid var(--outline)", 
            borderRadius: "0 0 4px 0",
        }
    }));

    let tooltipTimeout: NodeJS.Timeout = 0 as unknown as NodeJS.Timeout;

    let tooltipShown = ref<boolean>(false);
    let tooltipItem = ref<JSX.Element | string>("");
    let tooltipSide = ref<Direction>(Direction.Default);
    let tooltipStyle = ref<CSSProperties>({});

    function showTooltip(value: JSX.Element | string, target: Element, side: Direction = Direction.Default) {
        tooltipItem.value = value;
        tooltipShown.value = true;
        tooltipSide.value = side;

        setTimeout(() => {
            let selfRect = document.querySelector(".game-tooltip")?.getBoundingClientRect();
            let tarRect = target.getBoundingClientRect();
            
            if (!selfRect) return;

            let selfPos = {
                x: (selfRect.right + selfRect.left) / 2,
                y: (selfRect.bottom + selfRect.top) / 2,
            }
            let tarPos = {
                x: (tarRect.right + tarRect.left) / 2,
                y: (tarRect.bottom + tarRect.top) / 2,
            }

            let clampY = (x: number) => Math.min(Math.max(x, 8), window.innerHeight - selfRect!.height - 8);
            let clampX = (x: number) => Math.min(Math.max(x, 8), window.innerWidth - selfRect!.width - 8);

            if (side == Direction.Left) {
                tooltipStyle.value = {
                    right: window.innerWidth - (tarRect.left - 12) + "px",
                    top: clampY(tarPos.y - selfRect.height / 2) + "px"
                }
            }
            else if (side == Direction.Right) {
                tooltipStyle.value = {
                    left: (tarRect.right + 12) + "px",
                    top: clampY(tarPos.y - selfRect.height / 2) + "px"
                }
            }
            else if (side == Direction.Up) {
                tooltipStyle.value = {
                    left: clampX(tarPos.x - selfRect.width / 2) + "px",
                    bottom: window.innerHeight - (tarRect.top - 12) + "px"
                }
            }
            else if (side == Direction.Down) {
                tooltipStyle.value = {
                    left: clampX(tarPos.x - selfRect.width / 2) + "px",
                    top: (tarRect.bottom + 12) + "px"
                }
            }
        }, 0);
    }

    function hideTooltip() {
        tooltipShown.value = false;
    }

    let selectedBuilding = ref("");

    function canAffordBuilding(id: string) {
        if (!buildings[id]) return false;
        let costFactor = getBuildingCostFactor(id);
        let costReduction = getBuildingCostReduction(id);
        for (let [rid, cost] of Object.entries(buildings[id].baseCost)) {
            if (resources[rid].value < (cost - costReduction) * costFactor) return false;
        }
        return true;
    }

    function canAffordUpgrade(building: Building, id: string) {
        if (buildings[building.type].upgrades[id].max !== undefined && building.upgrades[id] >= (buildings[building.type].upgrades[id].max ?? 0) - 1) {
            return false;
        }
        for (let [uid, cost] of Object.entries(buildings[building.type].upgrades[id].cost(building.upgrades[id] ?? 0))) {
            if (resources[uid].value < cost) {
                return false;
            }
        }
        return true;
    }

    function buyUpgrade(building: Building, id: string) {
        if (canAffordUpgrade(building, id)) {
            for (let [uid, cost] of Object.entries(buildings[building.type].upgrades[id].cost(building.upgrades[id] ?? 0))) {
                resources[uid].value -= cost;
                building.sellValue[uid] = (building.sellValue[uid] ?? 0) + cost * 0.5;
            }
            building.upgrades[id] = (building.upgrades[id] ?? 0) + 1;
        }
    }

    function sellBuilding(loop: Loop) {
        if (loop.building && loop.building.type != "pins" && sellCooldown.value <= 0) {
            for (let [uid, val] of Object.entries(loop.building.sellValue)) {
                resources[uid].value += val;
                resourcesTotal[uid].value = Decimal.sub(resourcesTotal[uid].value, val).toNumber();
            }
            buildingFactor.value--;
            buildingFactors.value[loop.building.type] = (buildingFactors.value[loop.building.type] ?? 0) - 1;
            delete loop.building;
            
            sellCooldown.value = Decimal.mul(main.upgrades.sellCooldown.amount.value, -5).add(60).toNumber();

        }
    }


    function buildingItemMouseEnter(e: MouseEvent, building: BuildingType, id: string) {
        tooltipTimeout = setTimeout(() => {
            let costFactor = getBuildingCostFactor(id);
            let costReduction = getBuildingCostReduction(id);
            showTooltip(<>
                <h3>{building.name}</h3>{" "}
                <h5 style="display: inline-block; margin: 0"><i>- {building.class.toUpperCase()}</i></h5>
                <br />
                <i>{building.description}</i>
                <hr />
                <h5>BUILDING COST:</h5>
                <div class="stat-entries">
                    {Object.entries(building.baseCost).map(([id, cost]) => 
                        <div class={{red: resources[id].value < cost * costFactor}}>
                            <div class="name">{resources[id].displayName}</div>
                            <div class="value">{formatWhole((cost - costReduction) * costFactor)}</div>
                        </div>
                    )}  
                </div>
                <hr />
                <h5>STARTING SPECS:</h5>
                <div class="stat-entries">
                    {Object.entries(building.upgrades).map(([id, upg]) => 
                        <div>
                            <div class="name">{upg.name}</div>
                            <div class="value">{format(upg.effect(0), upg.precision ?? 0) + (upg.unit ?? "")}</div>
                        </div>
                    )}
                </div>
            </>, e.target as Element, Direction.Left);
        }, 500)
    }

    function buildingItemMouseLeave(e: MouseEvent, building: BuildingType, id: string) {
        clearTimeout(tooltipTimeout);
        hideTooltip();
    }

    function buildingItemClick(e: MouseEvent, building: BuildingType, id: string) {
        clearTimeout(tooltipTimeout);
        hideTooltip();
        if (canAffordBuilding(id)) {
            selectedBuilding.value = selectedBuilding.value == id ? "" : id;
        }
    }

    const endGameModalShown = ref<boolean>(false);

    return {
        name,
        color: "#afcfef",

        intro,
        outtro,

        cycle,
        cycleProgress,
        cycleBar,
        health,
        healthBar,

        gameState,
        gameSpeed,
        sellCooldown,
        upgrades,

        loops,
        buildingFactor,
        buildingFactors,

        resources,
        resourcesTotal,
        lifetime,

        board,

        startGame,
        endGame,

        display: jsx(() => (
            <>
                {render(board)}
                <div class={{
                    "game-top": true,
                    "hidden": gameState.value != GameState.Started || isAnimating.value || cycle.value <= 0
                }}>
                    <div style="display: flex; height: 31px">
                        <span class="bar-label">
                            {formatWhole(resources.energy.value)} energy
                        </span>
                        {Decimal.gt(resourcesTotal.info.value, 0) ? <span class="bar-label">
                            {formatWhole(resources.info.value)} info
                        </span> : ""}
                    </div>
                    {render(cycleBar)}
                    <div style="display: flex">
                        {render(stressBar)}
                        {render(healthBar)}
                    </div>
                </div>
                <div class={{
                    "game-bottom": true,
                    "hidden": gameState.value != GameState.Started || isAnimating.value
                }}>{(() => {
                    let state = (board.selectedNode.value?.state as { target: Loop } | undefined);
                    return <>
                        {state ? <div style="display: flex; height: 31px">
                            {state.target.building ? <div class="building-upgrades" style={{
                                "--layer-color": buildings[state.target.building.type].color
                            }}>
                                {
                                    Object.entries(buildings[state.target.building.type].upgrades).map(([id, upg]) => {
                                        let level = state?.target.building?.upgrades[id] ?? 0;
                                        let maxed = buildings[state?.target.building?.type ?? ""].upgrades[id].max !== undefined && 
                                            level >= (buildings[state?.target.building?.type ?? ""].upgrades[id].max ?? 0) - 1;

                                        return <button class={{
                                            feature: true,
                                            can: canAffordUpgrade(state?.target.building as Building, id)
                                        }} onClick={() => buyUpgrade(state?.target.building as Building, id)}>
                                            Level {formatWhole(level + 1) + (upg.max ? " / " + formatWhole(upg.max) : "")}<br/>
                                            <h3>{upg.name}</h3>
                                            <hr/>
                                            &uarr; {format(upg.effect(level + 1), upg.precision ?? 0) + (upg.unit ?? "")} &uarr;<br/>
                                            {format(upg.effect(level), upg.precision ?? 0) + (upg.unit ?? "")}<br/>
                                            <hr/>
                                            {Object.entries(upg.cost(level)).map(([id, cost]) => 
                                                formatWhole(cost) + " " + resources[id].displayName
                                            ).join(", ")}
                                        </button>
                                    })
                                }
                                {
                                    state.target.building.type == "pins" ? "" : <button class={{
                                        feature: true,
                                        can: sellCooldown.value <= 0,
                                    }} style="width: 100px; flex-basis: 100px" onClick={() => sellBuilding(state?.target as Loop)}>
                                        {sellCooldown.value <= 0 ? <>
                                            Sell for
                                            <hr/>
                                            {Object.entries(state.target.building.sellValue).map(([id, cost]) => 
                                                formatWhole(cost) + " " + resources[id].displayName
                                            ).join(", ")}
                                        </> : <>
                                            Sell cooldown
                                            <hr/>
                                            {formatTime(sellCooldown.value)}
                                        </>}
                                    </button>
                                }
                                
                            </div> : <span class="bar-label">
                                Select a building to build &rarr;
                            </span>}
                        </div> : Decimal.gt(resourcesTotal.info.value, 0) ? <div style="display: flex; height: 31px">
                            <div class="building-upgrades" style="--layer-color: #afcfef">
                                {Object.values(upgrades).map(render)}
                            </div>
                        </div> : ""}
                        <div style="display: flex; height: 31px">
                            <span>
                                {
                                    !state ? selectedBuilding.value ? "▲ Select a loop to build ▲" : 
                                    "▲ Select a loop from above ▲" :
                                    !state.target.building ? <i>No building</i> : 
                                    buildings[state.target.building.type].name
                                }
                            </span>
                        </div>
                    </>
                })()}</div>
                <div class={{
                    "game-left": true,
                    "hidden": gameState.value != GameState.Started || isAnimating.value || cycle.value <= 0
                }}>
                    <div class="action-list">
                        <button class="action" onClick={() => gamePaused.value = true}>
                            <div class="background">
                                <div class="icon">
                                     ☰
                                </div>
                            </div>
                        </button>

                        { main.selectedGameMode.value == "hardcore" ? "" : <>
                            {Decimal.gte(main.upgrades.speedManip.amount.value, 1) ? <>
                                <button class="action speed" onClick={() => gameSpeed.value = 0.000001}>
                                    <div class="background">
                                        <div class="icon">
                                            ⏸️
                                        </div>
                                    </div>
                                </button>
                                <button class="action speed" onClick={() => gameSpeed.value = 1}>
                                    <div class="background">
                                        <div class="icon">
                                            ▶
                                        </div>
                                    </div>
                                </button>
                            </> : ""}
                            {
                                [...Array(Decimal.sub(main.upgrades.speedManip.amount.value, 1).max(0).toNumber()).keys()].map((x) => 
                                    <button class="action speed" onClick={() => gameSpeed.value = x + 2}>
                                        <div class="background">
                                            <div class="icon">
                                                {x + 2}x
                                            </div>
                                        </div>
                                    </button>
                                )
                            }
                        </>}
                    </div>
                </div>
                <div class={{
                    "game-right": true,
                    "hidden": gameState.value != GameState.Started || isAnimating.value
                }}>
                    <div class="building-list">
                        {
                            main.selectedBuildings.value.map((id) => {
                                let building = buildings[id];
                                return <button 
                                    class={Object.fromEntries([
                                        [building.class, true],
                                        ["selected", selectedBuilding.value == id],
                                        ["disabled", !canAffordBuilding(id)],
                                    ])}
                                    onMouseenter={e => buildingItemMouseEnter(e, building, id)}
                                    onMouseleave={e => buildingItemMouseLeave(e, building, id)}
                                    onClick={e => buildingItemClick(e, building, id)}
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
                </div>
                <div class={{
                    "game-tooltip": true,
                    hidden: !tooltipShown.value,
                    left: tooltipSide.value == Direction.Left,
                    right: tooltipSide.value == Direction.Right,
                    top: tooltipSide.value == Direction.Up,
                    bottom: tooltipSide.value == Direction.Down,
                }} style={tooltipStyle.value}>
                    {tooltipItem.value}
                </div>
                <ModalVue
                    modelValue={gamePaused.value}
                    v-slots={{
                        header: () => <>
                            <h1 class="result-title">PAUSED</h1>
                            <h2 style="font-style: italic;">
                                - Operations halted. -
                            </h2>
                        </>,
                        body: () => <div style="text-align: center">
                            <div class="result-entry">
                                <div class="name">Cycles reached</div>
                                <h1 class="value">{formatWhole(cycle.value)}</h1>
                            </div> 
                            <div class="result-entry">
                                <div class="name">Relative lifetime</div>
                                <div class="value">{formatTime(lifetime.value)}</div>
                            </div> 
                            <div style="width: 75%; margin-top: 10px;">
                                <div class="name">Total resources gained:</div>
                                <div class="stat-entries">{Object.entries(resourcesTotal)
                                    .filter(([id, total]) => Decimal.gt(total.value, 0))
                                    .map(([id, total]) => <div>
                                        <div class="name">{resources[id].displayName}</div>
                                        <div class="value">{formatWhole(total.value)}</div>
                                    </div>) || "Nothing :("
                                }</div>
                            </div> 
                        </div>,
                        footer: () => (
                            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                                <button
                                    class="feature can"
                                    onClick={() => {
                                        endGame(1000, 0);
                                        setTimeout(() => {
                                            outtro();
                                        }, 1000);
                                        setTimeout(() => {
                                            loops.value = {}
                                        }, 2000);
                                        setTimeout(() => {
                                            main.points.value = Decimal.add(main.points.value, xpWorth.value).toNumber();
                                            endGameModalShown.value = false;
                                            intro();
                                            startGame();
                                        }, 2500);
                                        gamePaused.value = false;
                                    }}
                                >
                                    Restart
                                </button>
                                <button
                                    class="feature can"
                                    onClick={() => {
                                        endGame(1000, 0);
                                        setTimeout(() => {
                                            outtro();
                                        }, 1000);
                                        setTimeout(() => {
                                            main.points.value = Decimal.add(main.points.value, xpWorth.value).toNumber();
                                            gameState.value = GameState.Idle;
                                            endGameModalShown.value = false;
                                            player.tabs = ["main"];
                                            main.intro(2000);
                                        }, 2500);
                                        gamePaused.value = false;
                                    }}
                                >
                                    Forfeit and Return to Hub
                                </button>
                                <div style="flex-grow: 1" />
                                <button
                                    class="feature can"
                                    onClick={() => {
                                        gamePaused.value = false;
                                    }}
                                >
                                    Continue
                                </button>
                            </div>
                        )
                    }} />
                <ModalVue
                    modelValue={endGameModalShown.value}
                    v-slots={{
                        header: () => <>
                            <h1 class="result-title">GAME OVER</h1>
                            <h2 style="font-style: italic;">
                                - {gameStucked.value ? "You managed to softlock yourself..." : "The cycle has been broken."} -
                            </h2>
                        </>,
                        body: () => <div style="text-align: center">
                            <div class="result-entry">
                                <div class="name">Cycles reached</div>
                                <h1 class="value">{formatWhole(cycle.value)}</h1>
                            </div> 
                            <div class="result-entry">
                                <div class="name">Relative lifetime</div>
                                <div class="value">{formatTime(lifetime.value)}</div>
                            </div> 
                            <div style="width: 75%; margin-top: 10px;">
                                <div class="name">Total resources gained:</div>
                                <div class="stat-entries">{Object.entries(resourcesTotal)
                                    .filter(([id, total]) => Decimal.gt(total.value, 0))
                                    .map(([id, total]) => <div>
                                        <div class="name">{resources[id].displayName}</div>
                                        <div class="value">{formatWhole(total.value)}</div>
                                    </div>) || "Nothing :("
                                }</div>
                            </div> 
                            <div style="width: 75%; margin-top: 10px;">
                                <div class="name">Hub rewards:</div>
                                <div class="stat-entries">
                                    <div>
                                        <div class="name">XP</div>
                                        <div class="value">{formatWhole(xpWorth.value)}</div>
                                    </div>
                                </div>
                            </div> 
                        </div>,
                        footer: () => (
                            <div style="display: flex; text-align: center; --layer-color: #dadafa">
                                <button
                                    class="feature can"
                                    onClick={() => {
                                        setTimeout(() => {
                                            main.points.value = Decimal.add(main.points.value, xpWorth.value).toNumber();
                                            intro();
                                            startGame();
                                        }, 1000);
                                        endGameModalShown.value = false;
                                    }}
                                >
                                    Replay
                                </button>
                                <button
                                    class="feature can"
                                    onClick={(e) => {
                                        try {
                                            navigator.share({
                                                title: "Delooped",
                                                text: "I reached Cycle " + formatWhole(cycle.value) + " on Delooped!",
                                                url: "https://ducdat0507.itch.io/delooped",
                                            })
                                        } catch (error) {
                                            if (error instanceof TypeError) {
                                                navigator.clipboard.writeText(
                                                    "I reached Cycle " + formatWhole(cycle.value) + " on Delooped!\n" +
                                                    "https://ducdat0507.itch.io/delooped"
                                                );
                                                clearTimeout(tooltipTimeout);
                                                (e.target as HTMLElement).innerText = "Copied to clipboard";
                                                tooltipTimeout = setTimeout(() => (e.target as HTMLElement).innerText = "Share", 2000);
                                            }
                                        }
                                    }}
                                >
                                    Share
                                </button>
                                <div style="flex-grow: 1" />
                                <button
                                    class="feature can"
                                    onClick={() => {
                                        setTimeout(() => {
                                            main.points.value = Decimal.add(main.points.value, xpWorth.value).toNumber();
                                            gameState.value = GameState.Idle;
                                            player.tabs = ["main"];
                                            main.intro(2000);
                                        }, 1000);
                                        endGameModalShown.value = false;
                                    }}
                                >
                                    Return to Hub
                                </button>
                            </div>
                        )
                    }} />
            </>
        )),
        minimizable: false,
        classes: {  
            game: true
        }
    };
});

export default layer;
