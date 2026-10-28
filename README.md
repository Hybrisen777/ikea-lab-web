# IKEA Product Lab - web player

**Live: https://hybrisen777.github.io/ikea-lab-web/**

Interactive 3D assembly instructions and digital twins of IKEA products, running in the browser. A non-commercial
research demo from the Poznań University of Economics and Business (UEP), Department of Information Technology (KTI),
on XR-supported instructions and product use.

Nothing to install: open the link in a current desktop or mobile browser (Chrome, Edge, Firefox, Safari).

## What's inside

**Assembly guides** - every step animated from the parts kit to the finished product, next to the matching page of the
IKEA manual: ALEX drawer unit, BRIMNES wardrobe, IVAR cabinet, IVAR shelving, KALLAX, MALM bed, STEFAN chair,
STORKLINTA chest of drawers, TROTTEN desk (crank).

**Digital twins** - working models of appliances with guided tasks from their user manuals: SMAKLIG and BLIXTSNABB
induction hobs, FINSMAKARE (steam) and KULINARISK (pyrolytic) ovens, MATTRADITION oven and microwave, KALLBODA and
TORSBODA dishwashers, KNUVEBO extractor hood, STARKVIND air purifier.

**Assemble, then use** - STARKVIND table with air purifier and TROTTEN sit/stand desk (electric): build it, then press
*Assembled - now use it*.

## How to use

| | Assembly guides | Digital twins |
|---|---|---|
| Look around | drag = orbit, wheel / pinch = zoom, middle or Shift-drag = pan | right-drag or drag on empty space = orbit, wheel = zoom |
| Play | Space play / pause, ← → steps, J K L reverse / pause / play, − + speed | click keys and knobs, hold them where the manual says so |
| Help | click a part to identify it, X x-ray, C auto camera, M manual page | wheel over a knob turns it, Shift+click pins a key for two-key presses |
| Menu | Esc - settings, restart, other products | Esc - settings, restart, other products |

Settings (speed, step-by-step or continuous, camera, x-ray) are remembered in your browser.

## Found a problem?

Press **F8** (or *Report issue*). The report opens as a pre-filled GitHub issue in this repository, with the product,
step and state already filled in; the screenshot is saved to your downloads - drag it into the issue. A GitHub account
is needed, and issues are public, so please don't include personal data. You can also open an issue directly:
https://github.com/Hybrisen777/ikea-lab-web/issues

## How it's made

The products are modelled and validated in Unity (assembly motion is planned and collision-checked, appliances are
behaviour models built from their manuals). An exporter writes engine-independent data - step timelines, poses, device
descriptions - and this site plays it with [three.js](https://threejs.org) 0.169. Each digital twin is checked against
the Unity version by a replayed control sequence that must give identical states and displays.

This repository holds the built site only (generated - changes here are overwritten by the next build).

## Credits and rights

Research demo by Jeremi Ranosz, UEP / KTI. Not commercial, not affiliated with or endorsed by IKEA.
Product names, manual pages and product photos belong to Inter IKEA Systems B.V. and are used here for research and
demonstration. The site asks search engines not to index it.
