<template>
    <Modal v-model="isOpen">
        <template v-slot:header>
            <h1 class="result-title">RELOOPED</h1>
            <h2 style="font-style: italic;">
                - {{ versionTitle }} -
            </h2>
            <h4>
                v{{ versionNumber }}
            </h4>
        </template>
        <template v-slot:body="{ shown }">
            <div style="text-align: center" v-if="shown">
                <div v-if="author">by <a style="display: inline-block" href="https://maemoon.me" target="_blank">{{ author }}</a></div>
                <br />
                <div>
                    A mod of
                    <a style="display: inline-block" href="https://itch.io/jam/profectus-creation-jam" target="_blank">
                        Delooped
                    </a>
                    by ducdat0507
                </div>
                <div style="font-size: smaller; opacity: .5">
                    (Profectus by thepaperpilot, with inspiration from Acameada and Jacorb)
                </div>
                <br />
                <div class="link" @click="openChangelog">Changelog</div>
                <br />
                <div>
                    <a
                        :href="discordLink"
                        v-if="discordLink"
                        class="info-modal-discord-link"
                        target="_blank"
                    >
                        <span class="material-icons info-modal-discord">discord</span>
                        {{ discordName }}
                    </a>
                </div>
                <div>
                    <a
                        href="https://discord.gg/yJ4fjnjU54"
                        class="info-modal-discord-link"
                        target="_blank"
                    >
                        <span class="material-icons info-modal-discord">discord</span>
                        The Paper Pilot Community
                    </a>
                </div>
                <div>
                    <a
                        href="https://discord.gg/F3xveHV"
                        class="info-modal-discord-link"
                        target="_blank"
                    >
                        <span class="material-icons info-modal-discord">discord</span>
                        The Modding Tree
                    </a>
                </div>
                <br />
                <div>Time Played: {{ timePlayed }}</div>
                <component :is="infoComponent" />
            </div>
        </template>
    </Modal>
</template>

<script setup lang="tsx">
import Modal from "components/Modal.vue";
import type Changelog from "data/Changelog.vue";
import projInfo from "data/projInfo.json";
import { jsx } from "features/feature";
import player from "game/player";
import { infoComponents } from "game/settings";
import { formatTime } from "util/bignum";
import { coerceComponent, render } from "util/vue";
import { computed, ref, toRefs, unref } from "vue";

const { title, logo, author, discordName, discordLink, versionNumber, versionTitle } = projInfo;

const _props = defineProps<{ changelog: typeof Changelog | null }>();
const props = toRefs(_props);

const isOpen = ref(false);

const timePlayed = computed(() => formatTime(player.timePlayed));

const infoComponent = computed(() => {
    return coerceComponent(jsx(() => (<>{infoComponents.map(render)}</>)));
});

defineExpose({
    open() {
        isOpen.value = true;
    }
});

function openChangelog() {
    console.log(props.changelog);
    unref(props.changelog)?.open();
}
</script>

<style scoped>
.info-modal-header {
    display: flex;
    margin: -20px;
    margin-bottom: 0;
    background: var(--raised-background);
    align-items: center;
}

.info-modal-header * {
    margin: 0;
}

.info-modal-logo {
    height: 4em;
    width: 4em;
}

.info-modal-title {
    display: flex;
    flex-direction: column;
    padding: 10px 0;
    margin-left: 10px;
}

.info-modal-discord-link {
    display: flex;
    align-items: center;
}

.info-modal-discord {
    margin: 0;
    margin-right: 4px;
}
</style>
