class I18n {
    constructor() {
        this.defaultLang = 'en_US';
        this.currentLang = this.detectLanguage();
        this.translations = {};
    }

    detectLanguage() {
        const userLang = navigator.language || navigator.userLanguage;
        const formattedLang = userLang.replace('-', '_');
        if (formattedLang.startsWith('pt')) return 'pt_BR';
        return 'en_US';
    }

    async init() {
        try {
            const response = await fetch(`/langs/${this.currentLang}.json`);
            if (!response.ok) throw new Error("Idioma não encontrado.");
            this.translations = await response.json();
            this.translateDOM();
        } catch (error) {
            if (this.currentLang !== this.defaultLang) {
                this.currentLang = this.defaultLang;
                await this.init();
            }
        }
    }

    translateDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (this.translations[key]) el.textContent = this.translations[key];
        });
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
            const key = el.getAttribute('data-i18n-ph');
            if (this.translations[key]) el.placeholder = this.translations[key];
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    window.appI18n = new I18n();
    window.appI18n.init();
});