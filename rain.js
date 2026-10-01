(function () {
    var style = document.createElement("style");
    style.textContent = ""
        + ".rain{position:fixed;width:2px;height:80px;pointer-events:none;"
        + "background:linear-gradient(transparent,rgba(0,0,0,0.6));"
        + "transform:rotate(40deg);animation:fallDiagonal linear infinite;}"
        + "@keyframes fallDiagonal{"
        + "0%{transform:translate(0,-100px) rotate(40deg);opacity:0;}"
        + "10%{opacity:0.6;}"
        + "100%{transform:translate(-500px,120vh) rotate(40deg);opacity:0;}"
        + "}"
        + ".rainbow{position:fixed;top:-5%;left:100%;transform:translateX(-50%);"
        + "width:300vmax;height:300vmax;border-radius:50%;pointer-events:none;z-index:1;"
        + "opacity:0;filter:blur(4px);transition:opacity 4s ease-in-out;"
        + "background:radial-gradient(circle at center,"
        + "transparent 60%,"
        + "rgba(255,0,255,0.08) 61%,rgba(0,0,255,0.08) 63%,"
        + "rgba(0,255,255,0.08) 65%,rgba(0,255,0,0.08) 67%,"
        + "rgba(255,255,0,0.08) 69%,rgba(255,165,0,0.08) 71%,"
        + "rgba(255,0,0,0.08) 73%,transparent 75%);}";
    document.head.appendChild(style);

    function generateRain() {
        setInterval(function () {
            var rain = document.createElement("div");
            rain.className = "rain";
            rain.style.left = Math.random() * 65 + 35 + "%";
            rain.style.top = "-50px";
            rain.style.height = Math.random() * 60 + 40 + "px";
            rain.style.opacity = Math.random() * 0.4 + 0.2;
            rain.style.animationDuration = Math.random() * 2 + 3 + "s";
            document.body.appendChild(rain);
            setTimeout(function () { if (rain.parentNode) rain.remove(); }, 6000);
        }, Math.random() * 2000 + 1500);
    }

    function createRainbow() {
        var rainbow = document.createElement("div");
        rainbow.className = "rainbow";
        document.body.appendChild(rainbow);
        return rainbow;
    }

    generateRain();
    generateRain();

    var rainbowTimeout = null;
    var RAINBOW_DELAY = 3000;
    var rainbow = createRainbow();
    function showRainbow() { rainbow.style.opacity = "0.6"; }
    function hideRainbow() { rainbow.style.opacity = "0"; clearTimeout(rainbowTimeout); }
    function resetRainbowTimer() {
        hideRainbow();
        clearTimeout(rainbowTimeout);
        rainbowTimeout = setTimeout(showRainbow, RAINBOW_DELAY);
    }
    window.addEventListener("mousemove", resetRainbowTimer);
    window.addEventListener("click", resetRainbowTimer);
    window.addEventListener("scroll", resetRainbowTimer);
    resetRainbowTimer();
})();
