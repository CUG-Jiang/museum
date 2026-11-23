(() => {
    "use strict";

    const panorama = document.getElementById("panorama");
    const gallery = document.getElementById("scene-gallery");
    const galleryToggle = document.getElementById("gallery-toggle");
    const current = document.getElementById("current-scene");
    const dock = document.querySelector(".dock");
    const clearScreen = document.getElementById("clear-screen");
    const exitClearScreen = document.getElementById("exit-clear-screen");
    const notice = document.getElementById("notice");
    const noticeText = document.getElementById("notice-text");

    document.getElementById("reload").addEventListener("click", () => location.reload());

    function showError(message) {
        noticeText.textContent = message;
        notice.hidden = false;
        panorama.setAttribute("aria-busy", "false");
    }

    function setClearScreen(active) {
        dock.hidden = clearScreen.hidden = active;
        exitClearScreen.hidden = !active;
        if (!active) scrollToSelection();
        (active ? exitClearScreen : clearScreen).focus({ preventScroll: true });
    }

    clearScreen.addEventListener("click", () => setClearScreen(true));
    exitClearScreen.addEventListener("click", () => setClearScreen(false));
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !exitClearScreen.hidden) setClearScreen(false);
    });

    function setGallery(open) {
        gallery.hidden = !open;
        galleryToggle.setAttribute("aria-expanded", String(open));
        const label = open ? "隐藏场景照片" : "显示场景照片";
        galleryToggle.setAttribute("aria-label", label);
        galleryToggle.title = label;
        if (open) scrollToSelection();
    }

    function scrollToSelection() {
        const active = gallery.querySelector('[aria-current="true"]');
        if (!active || gallery.hidden) return;
        const item = active.getBoundingClientRect();
        const rail = gallery.getBoundingClientRect();
        if (item.left < rail.left || item.right > rail.right) {
            gallery.scrollLeft += item.left - rail.left - (rail.width - item.width) / 2;
        }
    }

    function createStepButton(container, options) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", "前往" + options.label);

        const marker = document.createElement("span");
        marker.className = "footprint-marker";
        marker.setAttribute("aria-hidden", "true");
        for (let i = 0; i < 2; i++) {
            const foot = document.createElement("i");
            foot.className = "footprint";
            marker.append(foot);
        }
        const label = document.createElement("span");
        label.className = "continue-label";
        label.textContent = options.label;
        button.append(marker, label);
        button.addEventListener("click", event => {
            event.stopPropagation();
            options.move();
        });
        container.append(button);
    }

    async function initialize() {
        if (!window.pannellum) throw new Error("Panorama renderer is unavailable");
        const response = await fetch("./exhibit.json");
        if (!response.ok) throw new Error("Exhibit list could not be loaded");
        const exhibit = await response.json();
        const scenes = exhibit.scenes;
        const assetPath = scene => "./assets/panos/" + scene.id;
        const rules = {};
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

        const routes = new Map();
        const sceneLabels = new Map(scenes.map(scene => [scene.id, scene.label]));
        let stepping = false;
        scenes.forEach((scene, index) => {
            const following = scenes[index + 1];
            const links = [...(exhibit.steps[scene.id] || [])];
            if (following && !links.some(link => link.to === following.id)) {
                links.push({ to: following.id });
            }
            routes.set(scene.id, links);

            rules[scene.id] = {
                preview: assetPath(scene) + "/poster.jpg",
                pitch: -2,
                yaw: 0,
                hfov: matchMedia("(max-width: 640px)").matches ? 88 : 104,
                multiRes: {
                    basePath: assetPath(scene),
                    path: "/%l/%s%y_%x",
                    fallbackPath: "/1/%s0_0",
                    extension: "jpg",
                    tileResolution: exhibit.tileSize,
                    maxLevel: exhibit.levels,
                    cubeResolution: exhibit.cubeSize
                },
                hotSpots: links.map((link, position) => ({
                    pitch: -19,
                    yaw: link.yaw ?? (position === 0 ? 8 : -35),
                    type: "info",
                    cssClass: "continue-hotspot",
                    createTooltipFunc: createStepButton,
                    createTooltipArgs: {
                        label: sceneLabels.get(link.to),
                        move: () => navigate(link.to, link)
                    }
                }))
            };
        });

        const viewer = pannellum.viewer("panorama", {
            default: {
                type: "multires",
                firstScene: scenes[0].id,
                autoLoad: true,
                showControls: false,
                showFullscreenCtrl: false,
                showZoomCtrl: false,
                orientationOnByDefault: false,
                sceneFadeDuration: reducedMotion ? 0 : 320,
                strings: {
                    loadingLabel: "正在载入全景",
                    loadButtonLabel: "载入全景",
                    genericWebGLError: "浏览器无法开启全景渲染。",
                    webglError: "浏览器无法开启全景渲染。"
                }
            },
            scenes: rules
        });

        function navigate(targetId, link) {
            const origin = viewer.getScene();
            if (origin === targetId || stepping || !viewer.isLoaded()) return;

            notice.hidden = true;
            const fov = viewer.getHfov();
            if (link?.sharedView) {
                viewer.loadScene(targetId, viewer.getPitch(), viewer.getYaw(), fov);
                return;
            }
            if (!Number.isFinite(link?.yaw)) {
                viewer.loadScene(targetId);
                return;
            }
            if (reducedMotion) {
                viewer.loadScene(targetId, -2, link.arrivalYaw, fov);
                return;
            }

            stepping = true;
            viewer.stopMovement();
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                stepping = false;
                if (viewer.getScene() === origin) {
                    viewer.loadScene(targetId, -2, link.arrivalYaw, fov);
                }
            };
            const timeout = setTimeout(finish, 520);
            viewer.lookAt(-6, link.yaw, fov * .86, 320, () => {
                clearTimeout(timeout);
                finish();
            });
        }

        const thumbnails = scenes.map(scene => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "scene";
            item.setAttribute("aria-current", "false");
            const image = document.createElement("img");
            image.width = 288;
            image.height = 162;
            image.loading = "lazy";
            image.decoding = "async";
            image.alt = "";
            image.src = assetPath(scene) + "/thumb.jpg";
            const caption = document.createElement("span");
            caption.textContent = scene.label;
            item.append(image, caption);
            item.addEventListener("click", () => {
                const link = routes.get(viewer.getScene())?.find(step => step.to === scene.id);
                navigate(scene.id, link);
            });
            gallery.append(item);
            return item;
        });

        function updateSelection(id) {
            const index = scenes.findIndex(scene => scene.id === id);
            if (index < 0) return;
            current.textContent = scenes[index].label + " / " + scenes.length;
            thumbnails.forEach((item, number) => {
                item.setAttribute("aria-current", String(number === index));
            });
            scrollToSelection();
        }

        viewer.on("scenechange", id => {
            panorama.setAttribute("aria-busy", "true");
            updateSelection(id);
        });
        function onSceneLoaded() {
            panorama.setAttribute("aria-busy", "false");
            notice.hidden = true;
            updateSelection(viewer.getScene());
        }
        viewer.on("load", onSceneLoaded);
        viewer.on("error", () => showError("全景暂时无法加载，请重试。"));

        galleryToggle.disabled = false;
        galleryToggle.addEventListener("click", () => setGallery(gallery.hidden));
        updateSelection(scenes[0].id);
        setGallery(true);
        if (viewer.isLoaded()) onSceneLoaded();
    }

    initialize().catch(error => {
        console.error(error);
        showError("展厅暂时无法加载，请重新打开。");
    });
})();
