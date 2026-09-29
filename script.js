document.addEventListener("DOMContentLoaded", () => {

    const PLACEHOLDER_AVATAR = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100%' height='100%' fill='#888'/></svg>`
    );
    const PLACEHOLDER_COVER_BOOK = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='150'><rect width='100%' height='100%' fill='#888'/><text x='50%' y='50%' fill='white' font-size='14' text-anchor='middle' dominant-baseline='middle'>Sem Capa</text></svg>`
    );
    const PLACEHOLDER_COVER_THEME = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='125'><rect width='100%' height='100%' fill='#888'/></svg>`
    );
    const CONFIG_STORAGE_KEY = 'bibliotecaAdgina.config';

    
    const frameCache = {};

    function avatarHTML(photo, equippedFrame, sizeClass, extraClass = '') {
        const p = photo || PLACEHOLDER_AVATAR;
        const frameUrl = equippedFrame ? frameCache[equippedFrame] : null;
        return `
        <span class="avatar-wrap ${sizeClass || ''} ${extraClass}">
            <img class="avatar-base" src="${p}" alt="">
            ${frameUrl ? `<img class="avatar-frame" src="${frameUrl}" alt="">` : ''}
        </span>
    `;
    }

    const state = {
        config: {
            loggedUser: null,
            theme: 'default',
            music: false,
            volume: 0.4
        },
        themes: [],
        posts: [],
        user: null,
        audioUnlocked: false,
        shopFilter: 'all',
        pendingMedia: [],
        readingBook: null,
        readingTimer: null,
        activePostId: null,
        activeCommentPostId: null,
        adminTab: 'queue',
        pubRequests: [],
        ugcFields: [],
        pdf: {
            doc: null,
            page: 1,
            total: 1,
            zoom: 1,
            url: null,
            activeSeconds: 0,
            earnedCoins: 0,
            pageFlip: null,
            pageElements: [],
            renderedPages: new Set(),
            rewardPending: false
        },
        activity: {
            currentBookFolder: null,
            bookStartTime: null,
            blurStart: null,
            awayStart: null,
            activeTabIndex: 0
        }
    };

    function canDeletePost(actor, post) {
        if (!actor || !post || !post.author) return false;
        const type = actor.accountType;
        if (type === 'owner' || type === 'admin') return true;
        if (post.author.email === actor.email) return true;
        if (type === 'teacher' && post.author.accountType === 'aluno') return true;
        return false;
    }

    gsap.from(".interactive-glass", {
        y: 40,
        opacity: 0,
        duration: 1.2,
        stagger: 0.15,
        ease: "back.out(1.7)"
    });
    gsap.from(".bg-shape", {
        scale: 0.6,
        opacity: 0,
        duration: 1.6,
        stagger: 0.25,
        ease: "elastic.out(1, 0.6)"
    });

    
    const tabs = document.querySelectorAll(".tab");
    const indicator = document.getElementById("tab-indicator");
    const pagesWrapper = document.getElementById("pages-wrapper");
    const swipeContainer = document.getElementById("swipe-container");
    const nav = document.getElementById("main-nav");
    let currentIndex = 0;
    let visibleTabs = Array.from(tabs);
    const maxIndex = () => visibleTabs.length - 1;
    let pillWidths = [],
        pillOffsets = [];

    const updatePillMetrics = () => {
        pillWidths = visibleTabs.map(t => t.offsetWidth);
        pillOffsets = visibleTabs.map(t => t.offsetLeft);
    };
    const updateTabs = (index, withBounce = true) => {
        if (index < 0) index = 0;
        if (index > maxIndex()) index = maxIndex();
        currentIndex = index;
        visibleTabs.forEach(t => t.classList.remove("active"));
        visibleTabs[index].classList.add("active");
        updatePillMetrics();

        const pct = 100 / visibleTabs.length;
        pagesWrapper.style.width = `${visibleTabs.length * 100}%`;
        document.querySelectorAll(".page").forEach(p => p.style.width = `${pct}%`);

        indicator.style.transition = "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1), width 0.4s";
        pagesWrapper.style.transition = "transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)";
        indicator.style.width = `${pillWidths[index]}px`;
        indicator.style.transform = `translateX(${pillOffsets[index]}px)`;
        pagesWrapper.style.transform = `translateX(-${index * pct}%)`;

        if (withBounce) gsap.fromTo(visibleTabs[index], {
            scale: 1
        }, {
            scale: 1.08,
            duration: 0.18,
            ease: "back.out(3)",
            yoyo: true,
            repeat: 1
        });

        const pageId = visibleTabs[index].dataset.index;
        state.activity.activeTabIndex = pageId;
        if (pageId === '1') loadPosts();
        if (pageId === '2') loadThemes();
        if (pageId === '3') loadAdminPanel();
        if (pageId === '4') loadTeacherPanel();
    };
    const recomputeVisibleTabs = () => {
        visibleTabs = Array.from(tabs).filter(t => !t.classList.contains('hidden'));
        updatePillMetrics();
        updateTabs(Math.min(currentIndex, visibleTabs.length - 1), false);
    };
    setTimeout(() => {
        recomputeVisibleTabs();
    }, 100);
    window.addEventListener("resize", () => updateTabs(currentIndex, false));

    visibleTabs.forEach((tab, i) => {
        tab.addEventListener("click", (e) => {
            e.preventDefault();
            const idx = visibleTabs.indexOf(tab);
            updateTabs(idx);
        });
    });

    
    let isSwipeDragging = false,
        swipeDragMoved = false,
        startXSwipe = 0;
    swipeContainer.addEventListener("pointerdown", (e) => {
        if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.cat-tab') ||
            e.target.closest('.theme-btn') || e.target.closest('.filter-tab') || e.target.closest('.post-action')) return;
        isSwipeDragging = true;
        swipeDragMoved = false;
        startXSwipe = e.clientX;
        updatePillMetrics();
    });
    window.addEventListener("pointermove", (e) => {
        if (!isSwipeDragging) return;
        const diffX = e.clientX - startXSwipe;
        if (Math.abs(diffX) > 5) {
            if (!swipeDragMoved) {
                swipeDragMoved = true;
                indicator.style.transition = "none";
                pagesWrapper.style.transition = "none";
            }
            const pct = 100 / visibleTabs.length;
            let progress = currentIndex - (diffX / window.innerWidth) * 1.3;
            if (progress < 0) progress = 0;
            if (progress > maxIndex()) progress = maxIndex();
            pagesWrapper.style.transform = `translateX(-${progress * pct}%)`;
            const f = Math.floor(progress),
                c = Math.ceil(progress),
                fr = progress - f;
            if (f !== c && pillWidths[f] && pillWidths[c]) {
                const w = pillWidths[f] + (pillWidths[c] - pillWidths[f]) * fr;
                const x = pillOffsets[f] + (pillOffsets[c] - pillOffsets[f]) * fr;
                indicator.style.width = `${w}px`;
                indicator.style.transform = `translateX(${x}px)`;
            }
        }
    });
    window.addEventListener("pointerup", (e) => {
        if (!isSwipeDragging) return;
        isSwipeDragging = false;
        if (swipeDragMoved) {
            const diffX = e.clientX - startXSwipe,
                th = 60;
            if (diffX < -th && currentIndex < maxIndex()) updateTabs(currentIndex + 1);
            else if (diffX > th && currentIndex > 0) updateTabs(currentIndex - 1);
            else updateTabs(currentIndex);
        }
    });

    
    let booksData = {};
    const catContainer = document.getElementById("category-tabs");
    const gridContainer = document.getElementById("books-grid");

    const renderBooks = (category) => {
        gridContainer.innerHTML = "";
        const books = booksData[category];
        if (!books || books.length === 0) {
            gridContainer.innerHTML = `<div class="empty-state"><i class="fa-regular fa-face-frown empty-icon"></i><span>Nenhum livro.</span></div>`;
            return;
        }
        books.forEach(book => {
            const card = document.createElement("a");
            card.href = "#";
            card.className = "book-card";
            card.dataset.coins = book.coinsPerMinute || 1;

            const img = document.createElement("img");
            img.className = "book-cover";
            img.src = book.coverUrl || PLACEHOLDER_COVER_BOOK;
            img.alt = book.nome || '';

            const info = document.createElement("div");
            info.className = "book-info";
            const h3 = document.createElement("h3");
            h3.className = "book-title";
            h3.textContent = book.nome || 'Sem título';
            const p = document.createElement("p");
            p.className = "book-author";
            p.textContent = book.autor || 'Desconhecido';
            info.appendChild(h3);
            info.appendChild(p);

            card.appendChild(img);
            card.appendChild(info);
            card.addEventListener("click", (ev) => {
                ev.preventDefault();
                openPdf(book);
            });
            gridContainer.appendChild(card);
        });
        gsap.fromTo(".book-card", {
            y: 40,
            opacity: 0,
            scale: 0.9
        }, {
            y: 0,
            opacity: 1,
            scale: 1,
            duration: 0.7,
            stagger: 0.05,
            ease: "back.out(2)"
        });
    };

    const fetchBooks = async () => {
        try {
            const res = await fetch("/api/books");
            booksData = await res.json();
            const cats = Object.keys(booksData);
            if (!cats.length) {
                gridContainer.innerHTML = `<div class="empty-state"><i class="fa-regular fa-folder-open empty-icon"></i><span>Sem livros.</span></div>`;
                return;
            }
            catContainer.innerHTML = "";
            cats.forEach((cat, i) => {
                const btn = document.createElement("button");
                btn.className = `cat-tab ${i === 0 ? "active" : ""}`;
                btn.textContent = cat;
                btn.addEventListener("click", () => {
                    catContainer.querySelectorAll(".cat-tab").forEach(b => b.classList.remove("active"));
                    btn.classList.add("active");
                    renderBooks(cat);
                });
                catContainer.appendChild(btn);
            });
            renderBooks(cats[0]);
        } catch (e) {}
    };
    fetchBooks();

    
    const pdfViewer = document.getElementById("pdf-viewer");
    const pdfCanvasWrap = document.getElementById("pdf-canvas-wrap");
    const pdfTitle = document.getElementById("pdf-title");
    const pdfZoomLabel = document.getElementById("pdf-zoom-label");
    const pdfPageLabel = document.getElementById("pdf-page-label");
    const pdfReadingTime = document.getElementById("pdf-reading-time");
    const pdfEarnedCoins = document.getElementById("pdf-earned-coins");
    let pdfToolbarTimeout = null;

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    function formatReadingTime(totalSeconds) {
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function updatePdfReadingStats() {
        pdfReadingTime.textContent = formatReadingTime(state.pdf.activeSeconds);
        pdfEarnedCoins.textContent = `+${state.pdf.earnedCoins}`;
    }

    function updatePdfPageLabel(pageIndex = state.pdf.page - 1) {
        const isSpread = state.pdf.pageFlip?.getOrientation() === 'landscape';
        const firstPage = Math.max(1, pageIndex + 1);
        const lastPage = Math.min(state.pdf.total, firstPage + (isSpread ? 1 : 0));
        pdfPageLabel.textContent = firstPage === lastPage
            ? `${firstPage} / ${state.pdf.total}`
            : `${firstPage}-${lastPage} / ${state.pdf.total}`;
        state.pdf.page = firstPage;
    }

    function showPdfToolbar() {
        pdfViewer.classList.remove('toolbar-hidden');
        clearTimeout(pdfToolbarTimeout);
        pdfToolbarTimeout = setTimeout(() => {
            if (!pdfViewer.classList.contains('hidden')) pdfViewer.classList.add('toolbar-hidden');
        }, 2400);
    }

    pdfViewer.addEventListener('pointermove', showPdfToolbar);
    pdfViewer.querySelector('.pdf-toolbar').addEventListener('pointerenter', () => {
        clearTimeout(pdfToolbarTimeout);
        pdfViewer.classList.remove('toolbar-hidden');
    });
    pdfViewer.querySelector('.pdf-toolbar').addEventListener('pointerleave', showPdfToolbar);

    async function openPdf(book) {
        if (!book.pdfUrl) {
            showToast({
                type: 'warn',
                title: 'Aviso',
                html: 'Este livro não tem PDF.'
            });
            return;
        }
        stopReading();
        if (state.pdf.pageFlip) {
            state.pdf.pageFlip.destroy();
            state.pdf.pageFlip = null;
        }
        state.readingBook = book;
        state.activity.currentBookFolder = book.folder;
        state.activity.bookStartTime = Date.now();
        state.pdf.activeSeconds = 0;
        state.pdf.earnedCoins = 0;
        state.pdf.pageElements = [];
        state.pdf.renderedPages = new Set();
        state.pdf.rewardPending = false;
        updatePdfReadingStats();

        pdfViewer.classList.remove("hidden");
        pdfViewer.classList.remove('toolbar-hidden');
        pdfTitle.textContent = book.nome || 'Documento';
        pdfCanvasWrap.innerHTML = "";
        showPdfToolbar();

        try {
            const loading = pdfjsLib.getDocument(book.pdfUrl);
            state.pdf.doc = await loading.promise;
            state.pdf.total = state.pdf.doc.numPages;
            state.pdf.page = 1;
            state.pdf.zoom = 1;
            state.pdf.url = book.pdfUrl;
            await renderPdfPage();

            
            startReadingSession();
        } catch (e) {
            pdfCanvasWrap.innerHTML = `<div style="color:#fff;padding:40px;">Erro ao carregar PDF.</div>`;
        }
    }

    async function renderPdfPage(startPage = state.pdf.page - 1) {
        if (!state.pdf.doc) return;
        if (state.pdf.pageFlip) {
            state.pdf.pageFlip.destroy();
            state.pdf.pageFlip = null;
        }
        pdfCanvasWrap.innerHTML = '<div id="pdf-flipbook"></div>';
        if (!state.pdf.pageElements.length) {
            state.pdf.pageElements = Array.from({ length: state.pdf.total }, (_, index) => {
                const element = document.createElement('div');
                element.className = 'pdf-flip-page';
                element.setAttribute('aria-label', `Página ${index + 1}`);
                return element;
            });
        }
        const flipbookElement = document.getElementById('pdf-flipbook');
        flipbookElement.style.transform = `scale(${state.pdf.zoom})`;
        flipbookElement.style.transformOrigin = 'center center';

        await Promise.all([
            renderPdfPageImage(Math.max(0, startPage)),
            renderPdfPageImage(Math.min(state.pdf.total - 1, startPage + 1))
        ]);

        if (window.St?.PageFlip) {
            state.pdf.pageFlip = new St.PageFlip(flipbookElement, {
                width: 520,
                height: 720,
                size: 'stretch',
                minWidth: 240,
                maxWidth: 600,
                minHeight: 320,
                maxHeight: 840,
                maxShadowOpacity: 0.35,
                drawShadow: true,
                flippingTime: 700,
                usePortrait: true,
                startPage: Math.min(startPage, state.pdf.total - 1),
                autoSize: true,
                showCover: false,
                mobileScrollSupport: true
            });
            state.pdf.pageFlip.loadFromHTML(state.pdf.pageElements);
            state.pdf.pageFlip.on('flip', event => {
                state.pdf.page = event.data + 1;
                updatePdfPageLabel(event.data);
                preloadNearbyPdfPages(event.data);
            });
            state.pdf.pageFlip.on('changeOrientation', () => updatePdfPageLabel());
            updatePdfPageLabel(startPage);
            preloadNearbyPdfPages(startPage);
        } else {
            flipbookElement.classList.add('pdf-flip-fallback');
            state.pdf.pageElements.slice(startPage, startPage + 2).forEach(element => flipbookElement.appendChild(element));
            state.pdf.page = startPage + 1;
            updatePdfPageLabel(startPage);
        }
        pdfZoomLabel.textContent = Math.round(state.pdf.zoom * 100) + "%";
    }

    async function renderPdfPageImage(pageIndex) {
        if (pageIndex < 0 || pageIndex >= state.pdf.total || state.pdf.renderedPages.has(pageIndex)) return;
        state.pdf.renderedPages.add(pageIndex);
        const pageElement = state.pdf.pageElements[pageIndex];
        try {
            const page = await state.pdf.doc.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context, viewport }).promise;
            const image = document.createElement('img');
            image.className = 'pdf-page-image';
            image.alt = `Página ${pageIndex + 1}`;
            image.src = canvas.toDataURL('image/jpeg', 0.9);
            pageElement.replaceChildren(image);
            canvas.width = 0;
            canvas.height = 0;
        } catch (error) {
            state.pdf.renderedPages.delete(pageIndex);
            pageElement.textContent = 'Não foi possível renderizar esta página.';
        }
    }

    function preloadNearbyPdfPages(pageIndex) {
        const first = Math.max(0, pageIndex - 2);
        const last = Math.min(state.pdf.total - 1, pageIndex + 3);
        for (let index = first; index <= last; index++) renderPdfPageImage(index);
    }

    function turnPdfSpread(direction) {
        if (state.pdf.pageFlip) {
            if (direction > 0) state.pdf.pageFlip.flipNext();
            else state.pdf.pageFlip.flipPrev();
            return;
        }
        const nextPage = Math.max(0, Math.min(state.pdf.total - 1, state.pdf.page - 1 + direction * 2));
        document.getElementById('pdf-flipbook').replaceChildren(...state.pdf.pageElements.slice(nextPage, nextPage + 2));
        state.pdf.page = nextPage + 1;
        updatePdfPageLabel(nextPage);
        preloadNearbyPdfPages(nextPage);
    }

    async function closePdf() {
        if (state.activity.currentBookFolder && state.activity.bookStartTime && state.user) {
            const secs = state.pdf.activeSeconds;
            if (secs > 0) {
                await fetch("/api/activity", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email,
                        event: 'read-time',
                        bookFolder: state.activity.currentBookFolder,
                        seconds: secs
                    })
                });
            }
        }
        stopReading();
        if (state.pdf.pageFlip) {
            state.pdf.pageFlip.destroy();
            state.pdf.pageFlip = null;
        }
        state.readingBook = null;
        state.activity.currentBookFolder = null;
        state.activity.bookStartTime = null;
        state.pdf.doc = null;
        state.pdf.pageElements = [];
        state.pdf.renderedPages = new Set();
        pdfViewer.classList.remove('toolbar-hidden');
        pdfViewer.classList.add("hidden");
    }

    document.getElementById("pdf-back").addEventListener("click", closePdf);
    document.getElementById("pdf-zoom-in").addEventListener("click", () => {
        state.pdf.zoom = Math.min(3, state.pdf.zoom + 0.2);
        renderPdfPage(state.pdf.page - 1);
    });
    document.getElementById("pdf-zoom-out").addEventListener("click", () => {
        state.pdf.zoom = Math.max(0.4, state.pdf.zoom - 0.2);
        renderPdfPage(state.pdf.page - 1);
    });
    document.getElementById("pdf-prev").addEventListener("click", () => turnPdfSpread(-1));
    document.getElementById("pdf-next").addEventListener("click", () => turnPdfSpread(1));
    document.getElementById("pdf-fullscreen").addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else pdfViewer.requestFullscreen();
    });

    
    document.addEventListener("keydown", (e) => {
        if (pdfViewer.classList.contains("hidden")) return;
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            turnPdfSpread(-1);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            turnPdfSpread(1);
        } else if (e.key === "+" || e.key === "=") {
            state.pdf.zoom = Math.min(3, state.pdf.zoom + 0.2);
            renderPdfPage(state.pdf.page - 1);
        } else if (e.key === "-") {
            state.pdf.zoom = Math.max(0.4, state.pdf.zoom - 0.2);
            renderPdfPage(state.pdf.page - 1);
        } else if (e.key === "f" || e.key === "F") {
            if (document.fullscreenElement) document.exitFullscreen();
            else pdfViewer.requestFullscreen();
        } else if (e.key === "Escape") closePdf();
    });

    
    function startReadingSession() {
        stopReading();
        state.readingTimer = setInterval(async () => {
            if (!state.readingBook || document.hidden || !document.hasFocus() || state.activity.blurStart) return;
            state.pdf.activeSeconds++;
            updatePdfReadingStats();
            if (!state.user || state.pdf.activeSeconds % 60 !== 0 || state.pdf.rewardPending) return;

            state.pdf.rewardPending = true;
            try {
                const previousCoins = Number(state.user.coins) || 0;
                const amount = Number(state.readingBook.coinsPerMinute) || 1;
                const response = await fetch('/api/earn-coins', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: state.user.email, amount })
                });
                const data = await response.json();
                if (response.ok && data.success) {
                    state.pdf.earnedCoins += Math.max(0, (Number(data.user.coins) || 0) - previousCoins);
                    state.user = data.user;
                    updateUserUI();
                    updatePdfReadingStats();
                    await fetch('/api/activity', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: state.user.email,
                            event: 'coin-tick',
                            bookFolder: state.activity.currentBookFolder,
                            seconds: 60
                        })
                    });
                }
            } catch (error) {
                showToast({ type: 'warn', title: 'Moedas não atualizadas', html: 'Não foi possível registrar as moedas desta leitura.' });
            } finally {
                state.pdf.rewardPending = false;
            }
        }, 1000);
    }

    function stopReading() {
        if (state.readingTimer) {
            clearInterval(state.readingTimer);
            state.readingTimer = null;
        }
    }

    
    document.addEventListener("visibilitychange", () => {
        if (!state.user) return;
        const evt = document.hidden ? 'hidden' : 'visible';
        fetch("/api/activity", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                event: evt
            })
        });
    });
    window.addEventListener("blur", () => {
        if (!state.user) return;
        state.activity.blurStart = Date.now();
        fetch("/api/activity", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                event: 'blur'
            })
        });
    });
    window.addEventListener("focus", () => {
        if (!state.user) return;
        if (state.activity.blurStart) {
            const away = Math.floor((Date.now() - state.activity.blurStart) / 1000);
            state.activity.blurStart = null;
            fetch("/api/activity", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: state.user.email,
                    event: 'focus',
                    seconds: away
                })
            });
        }
    });

    
    const bgMusic = document.getElementById("bg-music");
    const setAudioSource = (themeId) => {
        const src = `/themes/${themeId}/default.mp3`;
        if (bgMusic.src !== new URL(src, window.location.href).href) {
            bgMusic.src = src;
            bgMusic.load();
        }
    };
    const tryPlayMusic = () => {
        if (!state.config.music) return;
        bgMusic.volume = state.config.volume ?? 0.4;
        bgMusic.play().catch(() => {});
    };
    const unlockAudio = () => {
        if (state.audioUnlocked) return;
        state.audioUnlocked = true;
        if (state.config.music) tryPlayMusic();
        document.removeEventListener("click", unlockAudio);
        document.removeEventListener("keydown", unlockAudio);
    };
    document.addEventListener("click", unlockAudio);
    document.addEventListener("keydown", unlockAudio);

    
    const themeToggleBtn = document.getElementById("theme-toggle");
    const themeIcon = themeToggleBtn.querySelector("i");
    themeToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("dark-mode");
        const isDark = document.body.classList.contains("dark-mode");
        saveConfig({ darkMode: isDark });
        gsap.to(themeIcon, {
            rotation: 180,
            opacity: 0,
            scale: 0.4,
            duration: 0.2,
            ease: "back.in(2)",
            onComplete: () => {
                themeIcon.className = isDark ? "fas fa-sun" : "fas fa-moon";
                gsap.to(themeIcon, {
                    rotation: 360,
                    opacity: 1,
                    scale: 1,
                    duration: 0.7,
                    ease: "back.out(3)",
                    clearProps: "rotation"
                });
            }
        });
    });

    
    const openModal = (id) => {
        const ov = document.getElementById(id);
        ov.classList.add("open");
        const m = ov.querySelector(".modal");
        gsap.fromTo(m, {
            scale: 0.7,
            y: 40,
            opacity: 0
        }, {
            scale: 1,
            y: 0,
            opacity: 1,
            duration: 0.5,
            ease: "back.out(1.6)"
        });
    };
    const closeModal = (id) => {
        const ov = document.getElementById(id);
        const m = ov.querySelector(".modal");
        gsap.to(m, {
            scale: 0.85,
            y: 20,
            opacity: 0,
            duration: 0.25,
            ease: "back.in(2)",
            onComplete: () => {
                ov.classList.remove("open");
                gsap.set(m, {
                    clearProps: "all"
                });
            }
        });
    };
    document.querySelectorAll(".modal-close").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
    document.querySelectorAll(".modal-overlay").forEach(ov => ov.addEventListener("click", (e) => {
        if (e.target === ov) closeModal(ov.id);
    }));

    
    const toastContainer = document.getElementById("toast-container");

    function showToast({
        type = 'info',
        title = '',
        html = '',
        duration = 6000
    }) {
        const el = document.createElement("div");
        el.className = `toast ${type}`;
        const icons = {
            info: 'circle-info',
            success: 'circle-check',
            warn: 'triangle-exclamation',
            danger: 'circle-exclamation'
        };
        el.innerHTML = `
            <i class="toast-icon fas fa-${icons[type] || 'circle-info'}"></i>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-body">${html}</div>
            </div>
            <button class="toast-close"><i class="fas fa-xmark"></i></button>
        `;
        toastContainer.appendChild(el);
        gsap.fromTo(el, {
            x: 100,
            opacity: 0
        }, {
            x: 0,
            opacity: 1,
            duration: 0.5,
            ease: "back.out(1.6)"
        });
        const close = () => gsap.to(el, {
            x: 100,
            opacity: 0,
            duration: 0.3,
            ease: "back.in(2)",
            onComplete: () => el.remove()
        });
        el.querySelector(".toast-close").addEventListener("click", close);
        if (duration > 0) setTimeout(close, duration);
    }
    window.showToast = showToast;

    function showDialog({
        type = 'alert',
        title = 'Aviso',
        message = '',
        value = '',
        placeholder = '',
        inputType = 'text',
        confirmText = 'OK',
        cancelText = 'Cancelar'
    }) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay open';
            overlay.setAttribute('role', 'presentation');
            const modal = document.createElement('section');
            modal.className = 'modal glass dialog-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            const heading = document.createElement('h2');
            heading.textContent = title;
            const body = document.createElement('div');
            body.className = 'modal-body dialog-body';
            const text = document.createElement('p');
            text.textContent = message;
            body.appendChild(text);

            let input;
            if (type === 'prompt') {
                input = document.createElement(inputType === 'textarea' ? 'textarea' : 'input');
                if (input.tagName === 'INPUT') input.type = inputType;
                input.className = 'input';
                input.value = value ?? '';
                input.placeholder = placeholder;
                input.setAttribute('aria-label', title);
                body.appendChild(input);
            }

            const header = document.createElement('div');
            header.className = 'modal-header';
            header.appendChild(heading);
            const actions = document.createElement('div');
            actions.className = 'dialog-actions';
            let onKeydown;
            const finish = result => {
                document.removeEventListener('keydown', onKeydown);
                overlay.remove();
                resolve(result);
            };
            if (type !== 'alert') {
                const cancel = document.createElement('button');
                cancel.className = 'dialog-cancel';
                cancel.type = 'button';
                cancel.textContent = cancelText;
                cancel.addEventListener('click', () => finish(type === 'prompt' ? null : false));
                actions.appendChild(cancel);
            }
            const confirm = document.createElement('button');
            confirm.className = 'primary-btn';
            confirm.type = 'button';
            confirm.textContent = confirmText;
            confirm.addEventListener('click', () => finish(type === 'prompt' ? input.value : true));
            actions.appendChild(confirm);
            modal.append(header, body, actions);
            overlay.appendChild(modal);
            overlay.addEventListener('click', event => {
                if (event.target === overlay) finish(type === 'prompt' ? null : type === 'confirm' ? false : true);
            });
            onKeydown = event => {
                if (event.key === 'Escape') finish(type === 'prompt' ? null : type === 'confirm' ? false : true);
                if (event.key === 'Enter' && (!input || input.tagName !== 'TEXTAREA')) confirm.click();
            };
            document.addEventListener('keydown', onKeydown);
            document.body.appendChild(overlay);
            if (input) {
                input.focus();
                if (input.tagName === 'INPUT' && input.type !== 'number') input.select();
            } else confirm.focus();
        });
    }

    const showConfirm = (message, title = 'Confirmar') => showDialog({ type: 'confirm', title, message });
    const showPrompt = (message, value = '', options = {}) => showDialog({
        type: 'prompt',
        title: options.title || 'Informe os dados',
        message,
        value,
        placeholder: options.placeholder || '',
        inputType: options.inputType || 'text',
        confirmText: options.confirmText || 'Salvar'
    });

    function showAlertPopup(alert) {
        document.getElementById("alert-popup-title").textContent = alert.title || 'Aviso';
        document.getElementById("alert-popup-body").innerHTML = alert.html || '';
        openModal("alert-popup-modal");
    }

    async function pollAlerts() {
        try {
            const url = state.user ? `/api/alerts?email=${encodeURIComponent(state.user.email)}` : '/api/alerts';
            const res = await fetch(url);
            const alerts = await res.json();
            const seen = JSON.parse(sessionStorage.getItem("seenAlerts") || "[]");
            alerts.forEach(a => {
                if (seen.includes(a.id)) return;
                seen.push(a.id);
                if (a.type === 'popup') showAlertPopup(a);
                else showToast({
                    type: 'info',
                    title: a.title,
                    html: a.html,
                    duration: 8000
                });
            });
            sessionStorage.setItem("seenAlerts", JSON.stringify(seen));
        } catch (e) {}
    }
    setInterval(pollAlerts, 15000);
    setTimeout(pollAlerts, 1500);

    
    const musicToggle = document.getElementById("music-toggle");
    const volumeRange = document.getElementById("volume-range");
    const themeSelect = document.getElementById("theme-select");
    const requestDevBtn = document.getElementById("request-dev-btn");
    const devStatus = document.getElementById("dev-status");

    document.getElementById("settings-toggle").addEventListener("click", () => {
        openModal("settings-modal");
        updateDevStatusUI();
    });

    const loadConfig = async () => {
        try {
            const savedConfig = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || '{}');
            state.config = { ...state.config, ...savedConfig };
        } catch (e) {}
        document.body.classList.toggle('dark-mode', !!state.config.darkMode);
        themeIcon.className = state.config.darkMode ? 'fas fa-sun' : 'fas fa-moon';
        setAudioSource(state.config.theme || "default");
        bgMusic.volume = state.config.volume ?? 0.4;
        musicToggle.checked = !!state.config.music;
        volumeRange.value = state.config.volume ?? 0.4;
        if (state.config.music) tryPlayMusic();
        if (state.config.loggedUser) {
            const savedUser = state.config.loggedUser;
            try {
                const userResponse = await fetch(`/api/user/${encodeURIComponent(savedUser.email)}`);
                if (userResponse.ok) {
                    const currentUser = await userResponse.json();
                    state.user = currentUser;
                    state.config.loggedUser = currentUser;
                } else {
                    state.user = savedUser;
                }
            } catch (e) {
                state.user = savedUser;
            }
            updateUserUI();
            updateDevStatusUI();
            applyRoleUI();
        }
    };
    const saveConfig = async (patch) => {
        state.config = {
            ...state.config,
            ...patch
        };
        try {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(state.config));
        } catch (e) {}
    };
    musicToggle.addEventListener("change", async () => {
        await saveConfig({
            music: musicToggle.checked
        });
        if (musicToggle.checked) {
            setAudioSource(state.config.theme || "default");
            tryPlayMusic();
        } else bgMusic.pause();
    });
    volumeRange.addEventListener("input", () => {
        const v = parseFloat(volumeRange.value);
        bgMusic.volume = v;
        state.config.volume = v;
        saveConfig({
            volume: v
        });
    });
    themeSelect.addEventListener("change", async () => {
        await saveConfig({
            theme: themeSelect.value
        });
        applyTheme(themeSelect.value);
    });
    const applyTheme = (id) => {
        setAudioSource(id);
        bgMusic.onloadeddata = () => {
            if (state.config.music) tryPlayMusic();
        };
    };

    const updateDevStatusUI = () => {
        if (!state.user) {
            devStatus.textContent = "Faça login.";
            devStatus.className = "dev-status";
            requestDevBtn.disabled = true;
            return;
        }
        if (state.user.isDev) {
            devStatus.textContent = `Conta ${state.user.accountType.toUpperCase()}`;
            devStatus.className = "dev-status ok";
            requestDevBtn.disabled = true;
            requestDevBtn.textContent = "Ativo";
        } else {
            devStatus.textContent = "";
            devStatus.className = "dev-status";
            requestDevBtn.disabled = false;
            requestDevBtn.textContent = "Solicitar";
        }
    };
    requestDevBtn.addEventListener("click", async () => {
        if (!state.user) {
            openModal("login-modal");
            return;
        }
        const r = await fetch("/api/dev-request", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email
            })
        });
        const d = await r.json();
        if (d.success) {
            state.user.devRequested = true;
            updateDevStatusUI();
            showToast({
                type: 'success',
                title: 'Enviado',
                html: 'Solicitação enviada para análise.'
            });
        }
    });

    
    const avatarInput = document.getElementById("avatar-input");
    const avatarPreview = document.getElementById("avatar-preview");
    const loginError = document.getElementById("login-error");
    let avatarDataUrl = null;
    avatarPreview.src = PLACEHOLDER_AVATAR;

    document.getElementById("user-toggle").addEventListener("click", () => {
        if (state.user) {
            showConfirm("Deseja sair?", "Sair da conta").then(confirmed => {
                if (confirmed) logout();
            });
        } else openModal("login-modal");
    });
    avatarInput.addEventListener("change", () => {
        const f = avatarInput.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = (e) => {
            avatarDataUrl = e.target.result;
            avatarPreview.src = avatarDataUrl;
        };
        r.readAsDataURL(f);
    });
    document.getElementById("login-submit").addEventListener("click", async () => {
        const name = document.getElementById("login-name").value.trim();
        const email = document.getElementById("login-email").value.trim();
        const password = document.getElementById("login-password").value;
        loginError.textContent = "";
        try {
            const r = await fetch("/api/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name,
                    email,
                    password,
                    photo: avatarDataUrl
                })
            });
            const d = await r.json();
            if (!r.ok) {
                loginError.textContent = d.error;
                return;
            }
            state.user = d.user;
            await saveConfig({ loggedUser: state.user });
            updateUserUI();
            updateDevStatusUI();
            applyRoleUI();
            closeModal("login-modal");
            showToast({
                type: 'success',
                title: `Bem-vindo, ${state.user.name}!`,
                html: `Tipo: <strong>${state.user.accountType}</strong>`
            });
        } catch (e) {
            loginError.textContent = "Erro de conexão.";
        }
    });
    const logout = async () => {
        await fetch("/api/logout", {
            method: "POST"
        });
        state.user = null;
        await saveConfig({ loggedUser: null });
        updateUserUI();
        updateDevStatusUI();
        applyRoleUI();
    };

const updateUserUI = () => {
    const btn = document.getElementById("user-toggle");
    const shopUser = document.querySelector(".shop-user");
    const publishBtn = document.getElementById("publish-item-btn");

    if (state.user) {
        const photo = state.user.photo || PLACEHOLDER_AVATAR;

        // Botão do usuário no topo
        if (btn) {
            btn.innerHTML = avatarHTML(photo, state.user.equippedFrame, 'user-btn-avatar');
            const wrap = btn.querySelector('.avatar-wrap');
            const base = btn.querySelector('.avatar-base');
            if (wrap) { wrap.style.width = '30px'; wrap.style.height = '30px'; }
            if (base) { base.style.width = '30px'; base.style.height = '30px'; }
        }

        // Bloco do shop inteiro (avatar + nome + moedas)
        if (shopUser) {
            shopUser.innerHTML = `
                ${avatarHTML(photo, state.user.equippedFrame, 'shop-avatar-wrap')}
                <div>
                    <div class="shop-name" id="shop-name">${state.user.name} · ${state.user.accountType}</div>
                    <div class="shop-coins">
                        <i class="fas fa-coins"></i>
                        <span id="shop-coins">${Number(state.user.coins) || 0}</span> moedas
                    </div>
                </div>
            `;
            // Ajusta tamanho do avatar dentro do wrap
            const wrap = shopUser.querySelector('.avatar-wrap');
            const base = shopUser.querySelector('.avatar-base');
            if (wrap) { wrap.style.width = '55px'; wrap.style.height = '55px'; }
            if (base) { base.style.width = '55px'; base.style.height = '55px'; }
        }

        if (publishBtn) publishBtn.classList.remove("hidden");
    } else {
        if (btn) btn.innerHTML = `<i class="fas fa-user"></i>`;

        if (shopUser) {
            shopUser.innerHTML = `
                <img id="shop-avatar" class="shop-avatar" src="${PLACEHOLDER_AVATAR}" alt="">
                <div>
                    <div class="shop-name" id="shop-name">Visitante</div>
                    <div class="shop-coins">
                        <i class="fas fa-coins"></i>
                        <span id="shop-coins">0</span> moedas
                    </div>
                </div>
            `;
        }

        if (publishBtn) publishBtn.classList.add("hidden");
    }
};

    const applyRoleUI = () => {
        const accountType = String(state.user?.accountType || '').trim().toLowerCase();
        const isAdmin = !!state.user && (state.user.isAdmin || ['admin', 'administrator', 'owner'].includes(accountType));
        const isTeacher = !!state.user && ['teacher', 'teatcher', 'professor'].includes(accountType);
        const isOwner = !!state.user && (state.user.isOwner || accountType === 'owner');
        document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin));
        document.querySelectorAll(".teacher-only").forEach(el => el.classList.toggle("hidden", !isTeacher && !isAdmin));
        document.querySelectorAll('.owner-only').forEach(el => el.classList.toggle('hidden', !isOwner));
        recomputeVisibleTabs();
    };

    
    const themesGrid = document.getElementById("themes-grid");
    const shopFilters = document.getElementById("shop-filters");

    shopFilters.querySelectorAll(".filter-tab").forEach(btn => {
        btn.addEventListener("click", () => {
            shopFilters.querySelectorAll(".filter-tab").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            state.shopFilter = btn.dataset.filter;
            renderThemes();
        });
    });

    const loadThemes = async () => {
        try {
            const r = await fetch("/api/themes");
            state.themes = await r.json();
            state.themes.forEach(t => {
                if (t.type === 'ugc' && t.frameUrl) frameCache[t.id] = t.frameUrl;
            });
            renderThemes();
            renderThemeSelect();
        } catch (e) {}
    };

    const TYPE_LABEL = {
        theme: 'Tema',
        plugin: 'Plugin',
        ugc: 'UGC',
        unofficial: 'Unofficial'
    };

    const renderThemes = () => {
        themesGrid.innerHTML = "";
        const list = state.shopFilter === 'all' ? state.themes : state.themes.filter(t => t.type === state.shopFilter);
        if (!list.length) {
            themesGrid.innerHTML = `<div class="empty-state"><i class="fas fa-folder-open empty-icon"></i><span>Nada aqui.</span></div>`;
            return;
        }
        list.forEach(theme => {
            const owned = state.user?.ownedThemes?.includes(theme.id);
            const card = document.createElement("div");
            card.className = "theme-card";

            const badge = document.createElement("span");
            badge.className = "theme-type-badge";
            badge.textContent = TYPE_LABEL[theme.type] || theme.type;

            const img = document.createElement("img");
            img.className = "theme-cover";
            img.src = theme.coverUrl || PLACEHOLDER_COVER_THEME;
            img.alt = theme.name;

            let mediaEl = img;
            if (theme.type === 'ugc' && theme.ugcModules?.includes('profile-frame') && theme.frameUrl) {
                const preview = document.createElement("div");
                preview.className = "ugc-frame-preview";
                preview.innerHTML = `
        <div class="demo-photo"></div>
        <img class="frame-overlay" src="${theme.frameUrl}" alt="">
    `;
                mediaEl = preview;
            }

            const title = document.createElement("h3");
            title.className = "theme-title";
            title.textContent = theme.name;
            const desc = document.createElement("p");
            desc.className = "theme-desc";
            desc.textContent = theme.description || "";

            
            const starsRow = document.createElement("div");
            starsRow.className = "stars-row";
            const avg = theme.rating?.avg || 0;
            const your = state.user ? theme.rating?.byUser?.[state.user.email] : null;
            for (let i = 1; i <= 5; i++) {
                const s = document.createElement("i");
                s.className = "fas fa-star star" + (i <= Math.round(your || avg) ? " filled" : "") + (your ? " star-readonly" : "");
                if (!your && state.user) {
                    s.addEventListener("click", async () => {
                        const r = await fetch("/api/rate-item", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                email: state.user.email,
                                itemId: theme.id,
                                stars: i
                            })
                        });
                        const d = await r.json();
                        if (d.success) {
                            showToast({
                                type: 'success',
                                title: 'Avaliado',
                                html: `Você deu ${i} estrela(s)`
                            });
                            loadThemes();
                        }
                    });
                    s.addEventListener("mouseenter", () => starsRow.querySelectorAll(".star").forEach((x, idx) => x.classList.toggle("filled", idx < i)));
                    starsRow.addEventListener("mouseleave", () => starsRow.querySelectorAll(".star").forEach((x, idx) => x.classList.toggle("filled", idx < Math.round(your || avg))));
                }
                starsRow.appendChild(s);
            }
            const cnt = document.createElement("span");
            cnt.className = "stars-count";
            cnt.textContent = theme.rating?.count ? `(${theme.rating.count}) ${avg.toFixed(1)}` : '(sem avaliações)';
            starsRow.appendChild(cnt);

            const price = document.createElement("div");
            price.className = "theme-price";
            price.innerHTML = `<i class="fas fa-coins"></i> `;
            price.appendChild(document.createTextNode(String(theme.price ?? 0)));

            const btn = document.createElement("button");
            btn.className = `theme-btn ${owned ? 'owned' : ''}`;
            btn.textContent = owned ? 'Adquirido' : (theme.price === 0 ? 'Aplicar' : 'Comprar');
            btn.addEventListener("click", () => handleThemeAction(theme.id, btn));

            card.appendChild(badge);
            card.appendChild(mediaEl);
            card.appendChild(title);
            card.appendChild(desc);
            card.appendChild(starsRow);
            card.appendChild(price);
            card.appendChild(btn);
            themesGrid.appendChild(card);
        });
        gsap.fromTo(".theme-card", {
            y: 40,
            opacity: 0,
            scale: 0.9
        }, {
            y: 0,
            opacity: 1,
            scale: 1,
            duration: 0.7,
            stagger: 0.05,
            ease: "back.out(2)"
        });
    };
    const handleThemeAction = async (themeId, btnEl) => {
        if (!state.user) {
            openModal("login-modal");
            return;
        }
        const t = state.themes.find(x => x.id === themeId);
        const owned = state.user.ownedThemes.includes(themeId);
        if (owned || t.price === 0) {
            
            if (t.type === 'ugc' && t.ugcModules?.includes('profile-frame')) {
                const r = await fetch("/api/equip-frame", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email,
                        frameId: themeId
                    })
                });
                const d = await r.json();
                if (!r.ok) {
                    showToast({
                        type: 'danger',
                        title: 'Erro',
                        html: d.error
                    });
                    return;
                }
                state.user = d.user;
                updateUserUI();
                renderPosts();
                loadThemes();
                showToast({
                    type: 'success',
                    title: 'Moldura equipada!',
                    html: t.name
                });
                return;
            }
            await saveConfig({
                theme: themeId
            });
            applyTheme(themeId);
            return;
        }
        
        const r = await fetch("/api/buy-theme", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                themeId
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        state.user = d.user;
        updateUserUI();
        renderThemes();
        showToast({
            type: 'success',
            title: 'Comprado!',
            html: `Você adquiriu ${t.name}`
        });
    };

    const renderThemeSelect = () => {
        themeSelect.innerHTML = "";
        state.themes.filter(t => t.type === 'theme').forEach(t => {
            const o = document.createElement("option");
            o.value = t.id;
            o.textContent = t.name;
            themeSelect.appendChild(o);
        });
        themeSelect.value = state.config.theme || "default";
    };

    
    const pubTypeSel = document.getElementById("pub-type");
    const ugcFields = document.getElementById("ugc-fields");
    const pubZipInfo = document.getElementById("pub-zip-info");
    const pubZipInput = document.getElementById("pub-zip");
    let pendingZip = null;

    document.getElementById("publish-item-btn").addEventListener("click", () => {
        pubZipInfo.textContent = "";
        pubZipInput.value = "";
        pendingZip = null;
        openModal("publish-modal");
    });
    pubTypeSel.addEventListener("change", () => {
        ugcFields.classList.toggle("hidden", pubTypeSel.value !== "ugc");
    });
    const frameUploadWrap = document.getElementById("frame-upload-wrap");
    const pubFrameImage = document.getElementById("pub-frame-image");
    const pubFrameInfo = document.getElementById("pub-frame-info");
    let pendingFrameImage = null;

    document.querySelectorAll(".ugc-mod").forEach(cb => {
        cb.addEventListener("change", () => {
            const hasFrame = Array.from(document.querySelectorAll(".ugc-mod:checked"))
                .some(c => c.value === 'profile-frame');
            frameUploadWrap.classList.toggle("hidden", !hasFrame);
        });
    });

    pubFrameImage.addEventListener("change", () => {
        const f = pubFrameImage.files[0];
        if (!f) {
            pendingFrameImage = null;
            pubFrameInfo.textContent = "";
            return;
        }
        pubFrameInfo.textContent = `Selecionado: ${f.name}`;
        const r = new FileReader();
        r.onload = (e) => {
            pendingFrameImage = {
                name: f.name,
                dataUrl: e.target.result
            };
        };
        r.readAsDataURL(f);
    });
    pubZipInput.addEventListener("change", () => {
        const f = pubZipInput.files[0];
        if (!f) {
            pendingZip = null;
            pubZipInfo.textContent = "";
            return;
        }
        pubZipInfo.textContent = `Selecionado: ${f.name}`;
        const r = new FileReader();
        r.onload = (e) => {
            pendingZip = {
                name: f.name,
                dataUrl: e.target.result
            };
        };
        r.readAsDataURL(f);
    });
    document.getElementById("pub-submit").addEventListener("click", async () => {
        const errEl = document.getElementById("pub-error");
        errEl.textContent = "";
        if (!state.user) {
            openModal("login-modal");
            return;
        }

        const mods = Array.from(document.querySelectorAll(".ugc-mod:checked")).map(c => c.value);
        const payload = {
            email: state.user.email,
            item: pendingZip ? null : {
                id: document.getElementById("pub-id").value.trim(),
                name: document.getElementById("pub-name").value.trim(),
                description: document.getElementById("pub-desc").value.trim(),
                type: pubTypeSel.value,
                price: parseInt(document.getElementById("pub-price").value) || 0,
                code: document.getElementById("pub-code").value,
                ugcModules: mods,
                frameImage: pendingFrameImage
            },
            zip: pendingZip
        };

        
        const endpoint = state.user.isDev ? "/api/publish-item" : "/api/request-publish";
        const r = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (!r.ok) {
            errEl.textContent = d.error;
            return;
        }
        closeModal("publish-modal");
        if (state.user.isDev) {
            showToast({
                type: 'success',
                title: 'Publicado!',
                html: 'Item disponível no Workshop.'
            });
            loadThemes();
        } else {
            showToast({
                type: 'info',
                title: 'Enviado',
                html: 'Aguardando aprovação de um admin.'
            });
        }
    });

    
    const feedEl = document.getElementById("talk-feed");
    const editor = document.getElementById("editor");
    const mediaPreview = document.getElementById("media-preview");
    const postSubmit = document.getElementById("post-submit");
    const postPreview = document.getElementById("post-preview");
    const previewToggle = document.getElementById("preview-toggle");

    document.getElementById("new-post-btn").addEventListener("click", () => {
        if (!state.user) {
            openModal("login-modal");
            return;
        }
        editor.innerHTML = "";
        state.pendingMedia = [];
        renderMediaPreview();
        postSubmit.disabled = true;
        postPreview.classList.add("hidden");
        previewToggle.checked = false;
        openModal("post-modal");
    });
    document.querySelectorAll(".editor-btn[data-cmd]").forEach(b => b.addEventListener("click", () => {
        editor.focus();
        if (b.dataset.arg) document.execCommand(b.dataset.cmd, false, b.dataset.arg);
        else document.execCommand(b.dataset.cmd, false, null);
    }));
    document.getElementById("link-btn").addEventListener("click", () => {
        showPrompt("Informe o endereço do link.", "", { title: "Inserir link", placeholder: "https://" })
            .then(url => {
                if (url) document.execCommand("createLink", false, url);
            });
    });

    const fileToDataUrl = (f) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(f);
    });
    const uploadFile = async (filename, dataUrl) => (await fetch("/api/upload", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            filename,
            dataUrl
        })
    })).json();

    document.getElementById("media-image").addEventListener("change", async (e) => {
        for (const f of e.target.files) {
            const dataUrl = await fileToDataUrl(f);
            const up = await uploadFile(f.name, dataUrl);
            if (up.success) document.execCommand("insertHTML", false, `<img src="${up.url}" alt="">`);
        }
        e.target.value = "";
        updatePostButton();
    });
    document.getElementById("media-video").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const up = await uploadFile(f.name, await fileToDataUrl(f));
        if (up.success) {
            state.pendingMedia.push({
                type: 'video',
                url: up.url,
                name: f.name
            });
            renderMediaPreview();
        }
        e.target.value = "";
        updatePostButton();
    });
    document.getElementById("media-file").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const up = await uploadFile(f.name, await fileToDataUrl(f));
        if (up.success) {
            state.pendingMedia.push({
                type: 'file',
                url: up.url,
                name: f.name
            });
            renderMediaPreview();
        }
        e.target.value = "";
        updatePostButton();
    });

    const renderMediaPreview = () => {
        mediaPreview.innerHTML = "";
        state.pendingMedia.forEach((m, i) => {
            const chip = document.createElement("div");
            chip.className = "media-chip";
            chip.innerHTML = `<i class="fas fa-${m.type === 'video' ? 'video' : 'file'}"></i><span>${m.name}</span>`;
            const x = document.createElement("button");
            x.innerHTML = `<i class="fas fa-xmark"></i>`;
            x.addEventListener("click", () => {
                state.pendingMedia.splice(i, 1);
                renderMediaPreview();
            });
            chip.appendChild(x);
            mediaPreview.appendChild(chip);
        });
    };

    editor.addEventListener("input", updatePostButton);

    function updatePostButton() {
        const ok = editor.innerText.trim().length > 0 || editor.querySelector("img,video");
        postSubmit.disabled = !ok;
        if (previewToggle.checked) updatePreview();
    }
    previewToggle.addEventListener("change", () => {
        if (previewToggle.checked) {
            updatePreview();
            postPreview.classList.remove("hidden");
        } else postPreview.classList.add("hidden");
    });

    function updatePreview() {
        const a = state.user || {
            name: 'Você',
            photo: null,
            accountType: 'aluno'
        };
        postPreview.innerHTML = `
            <div class="preview-tag">Preview</div>
            <div class="post-header">
                <img class="post-avatar" src="${a.photo || PLACEHOLDER_AVATAR}" alt="">
                <div>
                    <div class="post-author">${a.name} <span class="post-badge ${a.accountType}">${a.accountType}</span></div>
                    <div class="post-time">agora</div>
                </div>
            </div>
            <div class="post-body">${editor.innerHTML}</div>
            ${state.pendingMedia.length ? `<div class="post-media">${state.pendingMedia.map(m => m.type === 'video' ? `<video src="${m.url}" controls></video>` : `<div class="file-attach"><i class="fas fa-file"></i><a href="${m.url}" target="_blank">${m.name}</a></div>`).join('')}</div>` : ''}
        `;
    }
    postSubmit.addEventListener("click", async () => {
        if (!state.user) return;
        const r = await fetch("/api/posts", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                html: editor.innerHTML,
                media: state.pendingMedia
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        closeModal("post-modal");
        loadPosts();
        showToast({
            type: 'success',
            title: 'Publicado!',
            html: 'Seu post está no ar.'
        });
    });

    const loadPosts = async () => {
        try {
            const r = await fetch("/api/posts");
            state.posts = await r.json();
            renderPosts();
        } catch (e) {}
    };

    
    const contextMenu = document.getElementById("context-menu");
    const ctxDelete = document.getElementById("ctx-delete-post");
    const ctxCancel = document.getElementById("ctx-cancel");
    const hideCtx = () => {
        contextMenu.classList.remove("open");
        document.querySelectorAll(".post-card.selected").forEach(c => c.classList.remove("selected"));
    };
    const showCtx = (x, y, postId) => {
        state.activePostId = postId;
        contextMenu.style.left = Math.min(x, window.innerWidth - 200) + "px";
        contextMenu.style.top = Math.min(y, window.innerHeight - 120) + "px";
        contextMenu.classList.add("open");
        const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
        if (card) card.classList.add("selected");
    };
    ctxCancel.addEventListener("click", hideCtx);
    ctxDelete.addEventListener("click", async () => {
        const id = state.activePostId;
        hideCtx();
        if (!id || !state.user) return;
        const r = await fetch(`/api/posts/${id}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        showToast({
            type: 'success',
            title: 'Apagado',
            html: 'Post removido.'
        });
        loadPosts();
    });
    document.addEventListener("click", (e) => {
        if (!contextMenu.contains(e.target)) hideCtx();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideCtx();
    });

    
    const renderPosts = () => {
        feedEl.innerHTML = "";
        if (!state.posts.length) {
            feedEl.innerHTML = `<div class="empty-state"><i class="fa-regular fa-comment empty-icon"></i><span>Nenhum post ainda.</span></div>`;
            return;
        }
        state.posts.forEach(post => {
            const card = document.createElement("div");
            card.className = "post-card";
            card.dataset.postId = post.id;

            const liked = state.user && post.likedBy?.includes(state.user.email);
            const type = post.author.accountType || 'aluno';
            const canDel = state.user && canDeletePost(state.user, post);

            const header = document.createElement("div");
            header.className = "post-header";
            header.innerHTML = `
    ${avatarHTML(post.author.photo, post.author.equippedFrame, 'post-avatar-wrap')}
    <div>
        <div class="post-author">${post.author.name} <span class="post-badge ${type}">${type}</span></div>
        <div class="post-time">${new Date(post.date).toLocaleString()}</div>
    </div>
`;
            if (canDel) {
                const del = document.createElement("button");
                del.className = "post-action danger";
                del.style.marginLeft = "auto";
                del.innerHTML = `<i class="fas fa-trash"></i>`;
                del.title = "Apagar post";
                del.addEventListener("click", async (ev) => {
                    ev.stopPropagation();
                    if (!await showConfirm("Apagar este post?", "Remover publicação")) return;
                    const r = await fetch(`/api/posts/${post.id}`, {
                        method: "DELETE",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            email: state.user.email
                        })
                    });
                    const d = await r.json();
                    if (!r.ok) {
                        showToast({
                            type: 'danger',
                            title: 'Erro',
                            html: d.error
                        });
                        return;
                    }
                    showToast({
                        type: 'success',
                        title: 'Apagado',
                        html: 'Post removido.'
                    });
                    loadPosts();
                });
                header.appendChild(del);
            }

            const body = document.createElement("div");
            body.className = "post-body";
            body.innerHTML = post.html;

            card.appendChild(header);
            card.appendChild(body);

            if (post.media?.length) {
                const mb = document.createElement("div");
                mb.className = "post-media";
                post.media.forEach(m => {
                    if (m.type === 'video') {
                        const v = document.createElement("video");
                        v.src = m.url;
                        v.controls = true;
                        mb.appendChild(v);
                    } else {
                        const a = document.createElement("div");
                        a.className = "file-attach";
                        a.innerHTML = `<i class="fas fa-file"></i>`;
                        const l = document.createElement("a");
                        l.href = m.url;
                        l.target = "_blank";
                        l.textContent = m.name;
                        a.appendChild(l);
                        mb.appendChild(a);
                    }
                });
                card.appendChild(mb);
            }

            const footer = document.createElement("div");
            footer.className = "post-footer";
            const likeBtn = document.createElement("button");
            likeBtn.className = `post-action like-btn ${liked ? 'liked' : ''}`;
            likeBtn.innerHTML = `<i class="fas fa-heart"></i> <span>${post.likes || 0}</span>`;
            likeBtn.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                if (!state.user) {
                    openModal("login-modal");
                    return;
                }
                const r = await fetch(`/api/posts/${post.id}/like`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email
                    })
                });
                const d = await r.json();
                if (d.success) loadPosts();
            });

            const cBtn = document.createElement("button");
            cBtn.className = "post-action comment-btn";
            cBtn.innerHTML = `<i class="fas fa-comment"></i> <span>${(post.comments || []).length}</span>`;
            cBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                openComments(post.id);
            });

            footer.appendChild(likeBtn);
            footer.appendChild(cBtn);
            card.appendChild(footer);

            
            card.addEventListener("contextmenu", (ev) => {
                ev.preventDefault();
                if (!state.user || !canDeletePost(state.user, post)) return;
                showCtx(ev.clientX, ev.clientY, post.id);
            });
            let pressTimer = null;
            card.addEventListener("touchstart", (ev) => {
                pressTimer = setTimeout(() => {
                    if (!state.user || !canDeletePost(state.user, post)) return;
                    const t = ev.touches[0];
                    showCtx(t.clientX, t.clientY, post.id);
                }, 500);
            });
            card.addEventListener("touchend", () => clearTimeout(pressTimer));
            card.addEventListener("touchmove", () => clearTimeout(pressTimer));

            feedEl.appendChild(card);
        });
        gsap.fromTo(".post-card", {
            y: 30,
            opacity: 0
        }, {
            y: 0,
            opacity: 1,
            duration: 0.6,
            stagger: 0.05,
            ease: "back.out(2)"
        });
    };

    
    const commentsList = document.getElementById("comments-list");
    const commentEditor = document.getElementById("comment-editor");
    const commentSubmit = document.getElementById("comment-submit");

    function openComments(postId) {
        state.activeCommentPostId = postId;
        const post = state.posts.find(p => p.id === postId);
        if (!post) return;
        commentsList.innerHTML = "";
        const cs = post.comments || [];
        if (!cs.length) commentsList.innerHTML = `<div class="empty-state" style="margin-top:20px;"><i class="fa-regular fa-comment empty-icon"></i><span>Sem comentários ainda.</span></div>`;
        else cs.forEach(c => {
            const item = document.createElement("div");
            item.className = "comment-item";
            const type = c.author.accountType || 'aluno';
            const canDel = state.user && canDeletePost(state.user, c);
            item.innerHTML = `
    ${avatarHTML(c.author.photo, c.author.equippedFrame, 'comment-avatar-wrap')}
    <div class="comment-content">                                <div class="comment-head">
                        <span class="comment-author">${c.author.name} <span class="post-badge ${type}">${type}</span></span>
                        <span class="comment-time">${new Date(c.date).toLocaleString()}</span>
                    </div>
                    <div class="comment-body">${c.html}</div></div>
`;
            if (canDel) {
                const del = document.createElement("button");
                del.className = "comment-delete";
                del.innerHTML = `<i class="fas fa-trash"></i>`;
                del.title = "Apagar comentário";
                del.addEventListener("click", async () => {
                    const r = await fetch(`/api/posts/${postId}/comments/${c.id}`, {
                        method: "DELETE",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            email: state.user.email
                        })
                    });
                    const d = await r.json();
                    if (!r.ok) {
                        showToast({
                            type: 'danger',
                            title: 'Erro',
                            html: d.error
                        });
                        return;
                    }
                    await loadPosts();
                    openComments(postId);
                });
                item.querySelector(".comment-head").appendChild(del);
            }
            commentsList.appendChild(item);
        });
        commentEditor.innerHTML = "";
        commentSubmit.disabled = true;
        openModal("comments-modal");
    }
    commentEditor.addEventListener("input", () => {
        commentSubmit.disabled = commentEditor.innerText.trim().length === 0;
    });
    commentSubmit.addEventListener("click", async () => {
        if (!state.user) return;
        const html = commentEditor.innerHTML.trim();
        if (!html) return;
        const r = await fetch(`/api/posts/${state.activeCommentPostId}/comments`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                html
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        commentEditor.innerHTML = "";
        commentSubmit.disabled = true;
        await loadPosts();
        openComments(state.activeCommentPostId);
    });

    
    const adminContent = document.getElementById("admin-content");
    document.querySelectorAll(".admin-tab").forEach(t => t.addEventListener("click", () => {
        document.querySelectorAll(".admin-tab").forEach(b => b.classList.remove("active"));
        t.classList.add("active");
        state.adminTab = t.dataset.tab;
        loadAdminPanel();
    }));

    async function loadAdminPanel() {
        const accountType = String(state.user?.accountType || '').trim().toLowerCase();
        const isAdmin = !!state.user && (state.user.isAdmin || ['admin', 'administrator', 'owner'].includes(accountType));
        if (!isAdmin) return;
        if (state.adminTab === 'queue') await renderQueue();
        else if (state.adminTab === 'items') await renderItemsAdmin();
        else if (state.adminTab === 'alerts') await renderAlertsAdmin();
        else if (state.adminTab === 'give-coins' && (state.user.isOwner || accountType === 'owner')) renderGiveCoinsAdmin();
    }

    function renderGiveCoinsAdmin() {
        adminContent.innerHTML = `
            <div class="admin-card">
                <h3>Give free coins</h3>
                <input type="email" id="coins-target-email" class="input" placeholder="E-mail do destinatário">
                <input type="number" id="coins-amount" class="input" min="1" step="1" placeholder="Quantidade de moedas" style="margin-top:8px;">
                <input type="text" id="coins-popup-title" class="input" maxlength="120" placeholder="Título do popup" style="margin-top:8px;">
                <div class="editor-toolbar" style="margin-top:8px;">
                    <button type="button" class="editor-btn" data-cmd="bold" title="Negrito"><i class="fas fa-bold"></i></button>
                    <button type="button" class="editor-btn" data-cmd="italic" title="Itálico"><i class="fas fa-italic"></i></button>
                    <button type="button" class="editor-btn" data-cmd="underline" title="Sublinhado"><i class="fas fa-underline"></i></button>
                    <button type="button" class="editor-btn" data-cmd="insertUnorderedList" title="Lista"><i class="fas fa-list-ul"></i></button>
                </div>
                <div id="coins-popup-editor" class="editor" contenteditable="true" data-placeholder="Mensagem especial do popup..." style="margin-top:8px;"></div>
                <button id="coins-give-submit" class="primary-btn" style="margin-top:10px;">Conceder moedas e enviar popup</button>
            </div>
        `;
        const editor = document.getElementById('coins-popup-editor');
        document.querySelectorAll('#admin-content .editor-btn').forEach(button => button.addEventListener('click', () => {
            editor.focus();
            document.execCommand(button.dataset.cmd, false, null);
        }));
        document.getElementById('coins-give-submit').addEventListener('click', async () => {
            const targetEmail = document.getElementById('coins-target-email').value.trim();
            const amount = Number(document.getElementById('coins-amount').value);
            const title = document.getElementById('coins-popup-title').value.trim();
            const html = editor.innerHTML.trim();
            if (!targetEmail || !Number.isSafeInteger(amount) || amount <= 0 || !title || !editor.textContent.trim()) {
                showToast({ type: 'warn', title: 'Dados incompletos', html: 'Informe destinatário, quantidade, título e mensagem.' });
                return;
            }
            const response = await fetch('/api/admin/give-coins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetEmail, amount, title, html })
            });
            const data = await response.json();
            if (!response.ok) {
                showToast({ type: 'danger', title: 'Não foi possível conceder', html: data.error || 'Ocorreu um erro.' });
                return;
            }
            showToast({ type: 'success', title: 'Moedas concedidas', html: `${amount} moedas enviadas para ${data.user.name}.` });
            document.getElementById('coins-target-email').value = '';
            document.getElementById('coins-amount').value = '';
            document.getElementById('coins-popup-title').value = '';
            editor.innerHTML = '';
        });
    }

    async function renderQueue() {
        adminContent.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin empty-icon"></i></div>`;
        const r = await fetch(`/api/pubrequests?email=${encodeURIComponent(state.user.email)}`);
        if (!r.ok) {
            adminContent.innerHTML = `<div class="empty-state">Sem permissão.</div>`;
            return;
        }
        const reqs = await r.json();
        adminContent.innerHTML = "";
        if (!reqs.length) {
            adminContent.innerHTML = `<div class="empty-state"><i class="fas fa-inbox empty-icon"></i><span>Sem solicitações.</span></div>`;
            return;
        }
        reqs.forEach(req => {
            const card = document.createElement("div");
            card.className = "admin-card";
            const verdict = req.analysis?.verdict || 'unknown';
            const score = req.analysis?.score || 0;
            const findings = req.analysis?.findings || [];
            const itemInfo = req.item ? `${req.item.type} · ${req.item.name} (${req.item.id})` : '(ZIP enviado)';

            card.innerHTML = `
                <h3>${req.author.name} <span class="post-badge ${req.author.accountType}">${req.author.accountType}</span></h3>
                <div class="meta">${itemInfo} · ${new Date(req.date).toLocaleString()} · status: <strong>${req.status}</strong></div>
                <div>Análise: <span class="verdict-badge verdict-${verdict}">${verdict}</span> (score ${score}/100)</div>
                ${findings.length ? `
                    <div class="findings-list">
                        <strong>Padrões detectados:</strong>
                        <ul>${findings.flatMap(f => f.findings.map(x => `<li class="level-${x.level}">[${x.level}] ${x.msg}${x.count>1?` ×${x.count}`:''} — <em>${f.file||'código'}</em></li>`)).join('')}</ul>
                    </div>
                ` : ''}
                ${req.item?.code ? `<details><summary>Ver código</summary><pre class="code-preview">${escapeHtml(req.item.code)}</pre></details>` : ''}
            `;
            const actions = document.createElement("div");
            actions.className = "admin-actions";
            if (req.status === 'pending') {
                const ap = document.createElement("button");
                ap.className = "approve";
                ap.innerHTML = `<i class="fas fa-check"></i> Aprovar`;
                ap.addEventListener("click", () => moderateRequest(req.id, 'approve'));
                const rj = document.createElement("button");
                rj.className = "reject";
                rj.innerHTML = `<i class="fas fa-xmark"></i> Rejeitar`;
                rj.addEventListener("click", () => moderateRequest(req.id, 'reject'));
                actions.appendChild(ap);
                actions.appendChild(rj);
            }
            card.appendChild(actions);
            adminContent.appendChild(card);
        });
    }

    async function moderateRequest(id, action) {
        const reason = action === 'reject'
            ? await showPrompt("Informe o motivo da rejeição (opcional).", "", { title: "Rejeitar solicitação" })
            : '';
        if (reason === null) return;
        const r = await fetch(`/api/pubrequests/${id}/${action}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                reason: reason || ''
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        showToast({
            type: 'success',
            title: action === 'approve' ? 'Aprovado' : 'Rejeitado',
            html: ''
        });
        renderQueue();
    }

    async function renderItemsAdmin() {
        adminContent.innerHTML = "";
        const items = state.themes;
        if (!items.length) {
            adminContent.innerHTML = `<div class="empty-state">Sem itens.</div>`;
            return;
        }
        items.forEach(it => {
            const card = document.createElement("div");
            card.className = "admin-card";
            card.innerHTML = `
                <h3>${it.name} <span class="theme-type-badge" style="position:static;">${it.type}</span></h3>
                <div class="meta">ID: ${it.id} · Autor: ${it.author} · Preço: ${it.price} moedas</div>
                <p>${it.description || ''}</p>
            `;
            const actions = document.createElement("div");
            actions.className = "admin-actions";
            const editBtn = document.createElement("button");
            editBtn.className = "neutral";
            editBtn.innerHTML = `<i class="fas fa-pen"></i> Editar nome/preço`;
            editBtn.addEventListener("click", async () => {
                const name = await showPrompt("Digite o novo nome do item.", it.name, { title: "Editar item" });
                if (name === null) return;
                const price = await showPrompt("Digite o novo preço em moedas.", it.price, { title: "Editar preço", inputType: "number" });
                if (price === null) return;
                const r = await fetch("/api/admin/edit-item", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email,
                        type: it.type,
                        id: it.id,
                        manifest: {
                            name,
                            price: parseInt(price) || 0
                        }
                    })
                });
                const d = await r.json();
                if (!r.ok) {
                    showToast({
                        type: 'danger',
                        title: 'Erro',
                        html: d.error
                    });
                    return;
                }
                showToast({
                    type: 'success',
                    title: 'Atualizado',
                    html: ''
                });
                loadThemes().then(loadAdminPanel);
            });
            const delBtn = document.createElement("button");
            delBtn.className = "reject";
            delBtn.innerHTML = `<i class="fas fa-trash"></i> Apagar`;
            delBtn.addEventListener("click", async () => {
                if (!await showConfirm(`Apagar o item "${it.name}"?`, "Excluir item")) return;
                const r = await fetch("/api/admin/delete-item", {
                    method: "DELETE",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email,
                        type: it.type,
                        id: it.id
                    })
                });
                const d = await r.json();
                if (!r.ok) {
                    showToast({
                        type: 'danger',
                        title: 'Erro',
                        html: d.error
                    });
                    return;
                }
                showToast({
                    type: 'success',
                    title: 'Apagado',
                    html: ''
                });
                loadThemes().then(loadAdminPanel);
            });
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            card.appendChild(actions);
            adminContent.appendChild(card);
        });
    }

    async function renderAlertsAdmin() {
        adminContent.innerHTML = `
            <div class="admin-card">
                <h3>Novo alerta</h3>
                <input type="text" id="alert-title" class="input" placeholder="Título">
                <select id="alert-type" class="input" style="margin-top:8px;">
                    <option value="toast">Toast (notificação)</option>
                    <option value="popup">Popup (modal)</option>
                </select>
                <input type="text" id="alert-target" class="input" style="margin-top:8px;" placeholder="global ou email@exemplo.com">
                <div class="editor-toolbar" style="margin-top:8px;">
                    <button type="button" class="editor-btn" data-cmd="bold"><i class="fas fa-bold"></i></button>
                    <button type="button" class="editor-btn" data-cmd="italic"><i class="fas fa-italic"></i></button>
                    <button type="button" class="editor-btn" data-cmd="underline"><i class="fas fa-underline"></i></button>
                </div>
                <div id="alert-editor" class="editor" contenteditable="true" data-placeholder="Mensagem (rich text)..." style="margin-top:8px;"></div>
                <button id="alert-send" class="primary-btn" style="margin-top:10px;">Enviar</button>
            </div>
            <h3>Alertas existentes</h3>
            <div id="alerts-list"></div>
        `;
        document.querySelectorAll("#admin-content .editor-btn").forEach(b => b.addEventListener("click", () => {
            document.getElementById("alert-editor").focus();
            document.execCommand(b.dataset.cmd, false, null);
        }));
        document.getElementById("alert-send").addEventListener("click", async () => {
            const html = document.getElementById("alert-editor").innerHTML.trim();
            const title = document.getElementById("alert-title").value.trim();
            const type = document.getElementById("alert-type").value;
            const target = document.getElementById("alert-target").value.trim() || 'global';
            if (!html) {
                showToast({
                    type: 'warn',
                    title: 'Vazio',
                    html: 'Escreva a mensagem.'
                });
                return;
            }
            const r = await fetch("/api/alerts", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: state.user.email,
                    alert: {
                        type,
                        target,
                        title,
                        html
                    }
                })
            });
            const d = await r.json();
            if (!r.ok) {
                showToast({
                    type: 'danger',
                    title: 'Erro',
                    html: d.error
                });
                return;
            }
            showToast({
                type: 'success',
                title: 'Enviado',
                html: ''
            });
            renderAlertsAdmin();
        });

        const list = await fetch(`/api/alerts/all?email=${encodeURIComponent(state.user.email)}`).then(r => r.json()).catch(() => []);
        const listEl = document.getElementById("alerts-list");
        (list || []).forEach(a => {
            const c = document.createElement("div");
            c.className = "admin-card";
            c.innerHTML = `<h3>${a.title || '(sem título)'} <span class="theme-type-badge" style="position:static;">${a.type}</span></h3>
                           <div class="meta">Alvo: ${a.target} · ${new Date(a.date).toLocaleString()}</div>
                           <div>${a.html}</div>`;
            const del = document.createElement("button");
            del.className = "reject";
            del.innerHTML = `<i class="fas fa-trash"></i>`;
            del.addEventListener("click", async () => {
                await fetch(`/api/alerts/${a.id}`, {
                    method: "DELETE",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: state.user.email
                    })
                });
                renderAlertsAdmin();
            });
            const act = document.createElement("div");
            act.className = "admin-actions";
            act.appendChild(del);
            c.appendChild(act);
            listEl.appendChild(c);
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        } [c]));
    }

    document.getElementById("unequip-frame").addEventListener("click", async () => {
        if (!state.user) return;
        const r = await fetch("/api/equip-frame", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: state.user.email,
                frameId: null
            })
        });
        const d = await r.json();
        if (!r.ok) {
            showToast({
                type: 'danger',
                title: 'Erro',
                html: d.error
            });
            return;
        }
        state.user = d.user;
        updateUserUI();
        renderPosts();
        showToast({
            type: 'success',
            title: 'Moldura removida',
            html: ''
        });
    });

    
    async function loadTeacherPanel() {
        const container = document.getElementById("teacher-content");
        container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin empty-icon"></i></div>`;
        if (!state.user) return;
        const r = await fetch(`/api/activity/all?email=${encodeURIComponent(state.user.email)}`);
        if (!r.ok) {
            container.innerHTML = `<div class="empty-state">Sem permissão.</div>`;
            return;
        }
        const students = await r.json();
        container.innerHTML = "";
        if (!students.length) {
            container.innerHTML = `<div class="empty-state">Sem alunos.</div>`;
            return;
        }

        students.forEach(s => {
            const card = document.createElement("div");
            card.className = "teacher-card";
            const totalReadMin = Object.values(s.totals || {}).reduce((a, b) => a + b, 0) / 60;
            const events = (s.lastEvents || []).slice().reverse().slice(0, 15);
            card.innerHTML = `
                <div class="teacher-head">
                    ${avatarHTML(s.photo, s.equippedFrame, 'teacher-avatar-wrap')}
                    <div>
                        <div style="font-weight:700;">${s.name}</div>
                        <div style="font-size:0.8rem;opacity:0.7;">${s.email}</div>
                    </div>
                </div>
                <div class="teacher-stats">
                    <div class="teacher-stat"><i class="fas fa-book"></i> ${totalReadMin.toFixed(1)} min lidos</div>
                    <div class="teacher-stat"><i class="fas fa-coins"></i> ${s.coins} moedas</div>
                    <div class="teacher-stat"><i class="fas fa-clock"></i> visto: ${s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString() : '-'}</div>
                </div>
                <div class="teacher-events">
                    <ul>${events.map(e => {
                        const cls = e.event === 'hidden' ? 'hidden' : e.event === 'blur' ? 'blur' : e.event === 'focus' ? '' : e.event === 'visible' ? '' : 'away';
                        return `<li><span class="event-badge ${cls}">${e.event}</span> ${e.bookFolder || ''} ${e.seconds ? `(+${e.seconds}s)` : ''} <em>${new Date(e.date).toLocaleTimeString()}</em></li>`;
                    }).join('')}</ul>
                </div>
            `;
            container.appendChild(card);
        });
    }

    
    const clickSound = new Audio("/themes/default/select.mp3");
    clickSound.volume = 0.4;
    document.addEventListener("click", (e) => {
        if (e.target.closest("button, a, .cat-tab, .theme-btn, .filter-tab, .post-action")) {
            try {
                clickSound.currentTime = 0;
                clickSound.play().catch(() => {});
            } catch (e) {}
        }
    });

    
    loadConfig();
    updateUserUI();
    updateDevStatusUI();
    applyRoleUI();
});