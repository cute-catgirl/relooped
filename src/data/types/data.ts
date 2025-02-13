import { Shape } from "features/boards/board";
import { CoercableComponent } from "features/feature";
import { NonPersistent, State } from "game/persistence";
import { Ref } from "vue";

export const BoardID = Symbol("BoardID");
export const BoardConnections = Symbol("BoardConnections");

export type Loop = {
    building?: Building;
    enemies: Enemy[];
    [BoardID]?: number;
}

export type Building = {
    type: string;
    upgrades: { [key: string]: number };
    data: { [key: string]: State };
    sellValue: { [key: string]: number };
    [BoardID]?: number;
}

export type Enemy = {
    angle: number,
    lifetime: number,
    speed: number,
    health: number,
    maxHealth: number,
    effects: { [key: string]: number };
    loot: { [key: string]: number };
    [BoardID]?: number;
    [BoardConnections]?: { [key: number]: number };
}

export type BuildingType = {
    name: string;
    icon: string;
    color: string;
    class: BuildingClass;
    description: CoercableComponent;
    baseCost: { [key: string]: number };
    upgrades: { [key: string]: BuildingUpgrade };

    onUpdate?: (self: Building, loop: Loop, delta: number, influences: { [key: string]: number }) => void;
    onEnemyEnter?: (self: Building, loop: Loop, enemy: Enemy, influences: { [key: string]: number }) => void;
    onEnemyExit?: (self: Building, loop: Loop, enemy: Enemy, influences: { [key: string]: number }) => void;

    progress?: (self: Building) => void;
    influences?: (self: Building, loop: Loop) => { [key: string]: number };
}

export type BuildingUpgrade = {
    name: string;
    effect: (level: number) => number;
    cost: (level: number) => { [key: string]: number };
    max?: number;
    precision?: number;
    unit?: string;
}

export type BuildingClass = 
    "damager" |
    "effector" |
    "influencer" |
    "generator"
    

export type Objective = {
    name: string;
    description: string;
    target: Ref<number>;
    goal: (level: number) => number;
    goalPrecision?: number;
    reward: (level: number) => [RewardType, number];
    exclusiveRewards: { [level: number]: [ExclusiveRewardType, string] };
    rewardPrecision?: number;
}
export type SpecialObjective = {
    name: string;
    description: string;
    reward: [ExclusiveRewardType, string];
}

export type RewardType = 
    "xp" | "capsules"

export type ExclusiveRewardType = 
    "building"

export type CapsuleUpgrade = {
    name: string;
    description: string;
    formula: (level: number) => number;
    precision?: number;
    visibility?: () => boolean;
}
