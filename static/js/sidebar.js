document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('settings-sidebar');
    const mainContent = document.getElementById('main-content');
    const toggleButton = document.getElementById('sidebar-toggle');
    const overlay = document.getElementById('sidebar-overlay');

    if (!sidebar || !mainContent || !toggleButton) {
        console.warn("Sidebar elements not found, skipping sidebar script.");
        return;
    }

    const isMobile = () => window.innerWidth < 768; // Tailwind's 'md' breakpoint

    const openSidebar = () => {
        sidebar.classList.remove('-translate-x-full');
        mainContent.classList.add('md:ml-80');
        if (isMobile()) {
            overlay.classList.remove('hidden');
        }
    };

    const closeSidebar = () => {
        sidebar.classList.add('-translate-x-full');
        mainContent.classList.remove('md:ml-80');
        overlay.classList.add('hidden');
    };

    toggleButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sidebar.classList.contains('-translate-x-full')) {
            openSidebar();
        } else {
            closeSidebar();
        }
    });

    if (overlay) {
        overlay.addEventListener('click', closeSidebar);
    }
    
    // Set initial state based on screen size
    if (!isMobile()) {
        // We start open on desktop
        sidebar.classList.remove('-translate-x-full');
        mainContent.classList.add('md:ml-80');
    } else {
        // We start closed on mobile
        sidebar.classList.add('-translate-x-full');
        mainContent.classList.remove('md:ml-80');
    }
    
    // Optional: Adjust on resize
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            // If we resize to desktop, make sure the overlay is hidden
            overlay.classList.add('hidden');
        }
    });
});
