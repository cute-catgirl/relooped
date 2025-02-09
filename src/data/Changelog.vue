<template>
    <Modal v-model="isOpen">
        <template v-slot:header>
            <h2>Changelog</h2>
        </template>
        <template v-slot:body>
            <details open>
                <summary>v0.6 Relooped - <time>2025-02-08</time></summary>
                <ul>
                    <li class="feature">Added building enhancements</li>
                </ul>
            </details>
            <details open>
                <summary>v0.5 The Last Update (for now) - <time>2023-05-29</time></summary>
                <ul>
                    <li class="feature">Added new buildings</li>
                    <li class="changed">Added transition animations between hub and game</li>
                </ul>
            </details>
            <details open>
                <summary>v0.4 this game isn't that great tbh - <time>2023-05-28</time></summary>
                <ul>
                    <li class="feature">Added new buildings</li>
                    <li class="changed">Adjusted enemies' health formula</li>
                    <li class="changed">Changed how game modes affect health</li>
                    <li class="changed">Style polishments</li>
                </ul>
            </details>
            <details>
                <summary>v0.3 Lesser Prototypey Thing - <time>2023-05-27</time></summary>
                <ul>
                    <li class="feature">Added new building type - Influencer</li>
                    <li class="feature">Added new buildings</li>
                    <li class="feature">Added new objectives</li>
                </ul>
            </details>
            <details>
                <summary>v0.2.1 Slightly Less Prototypey Thing - <time>2023-05-27</time></summary>
                <ul>
                    <li class="fix">Fix breaking error</li>
                </ul>
            </details>
            <details>
                <summary>v0.2 Slightly Less Prototypey Thing - <time>2023-05-26</time></summary>
                <ul>
                    <li class="feature">Added the meta game</li>
                    <li class="feature">Added more buildings</li>
                </ul>
            </details>
            <details>
                <summary>v0.1 Prototype Thing - <time>2023-05-25</time></summary>
                This is the first release :D
                <ul>
                    <li class="feature">Did everything</li>
                    <li class="fix">Had some fun</li>
                    <li class="breaking">Removed everything</li>
                    <li class="changed">Created some bugs to fix later</li>
                </ul>
            </details>
        </template>
    </Modal>
</template>

<script setup lang="ts">
import Modal from "components/Modal.vue";
import { ref } from "vue";

const isOpen = ref(false);

defineExpose({
    open() {
        isOpen.value = true;
    }
});
</script>

<style scoped>
details {
    margin: 10px 0;
    padding-left: 18px;
}

summary {
    cursor: pointer;
    margin-bottom: 10px;
    margin-left: -18px;
}

ul {
    margin: var(--feature-margin) 0;
    background: var(--raised-background);
    border: 2px solid rgba(0, 0, 0, 0.125);
    padding: 5px 5px 5px 15px;
    list-style: inside;
}

li {
    margin: 8px 0;
}

li::before {
    padding: 2px 8px;
    margin-right: 8px;
    border-radius: var(--border-radius);
}

.feature::before {
    content: "Feature";
    background: var(--accent1);
    color: var(--background);
}

.fix::before {
    content: "Fix";
    background: var(--accent2);
    color: var(--background);
}

.changed::before {
    content: "Changed";
    background: var(--accent3);
    color: var(--background);
}

.breaking::before {
    content: "Breaking";
    background: var(--danger);
    color: var(--background);
}
</style>
