# WaveForge Session Notes

## Session 1 — 2026-04-24: CMake Migration & CI

### What We Accomplished

### 1. CMake Build System (`firmware/CMakeLists.txt`)
Replaced the Eclipse CDT managed build (`.cproject`) with a clean CMake setup that:
- Targets STM32F405VGTx (Cortex-M4F, `-mfpu=fpv4-sp-d16 -mfloat-abi=hard`)
- Preserves the bootloader flash offset — application starts at `0x800C000` via `STM32F405VGTX_FLASH.ld`
- Handles all 8 build variants via `-DPLATFORM=` and boolean options (see below)
- Applies per-file `-O0` override on `codec_interface.c` (all other sources use `-Os`)
- Embeds the git short hash at configure time for version strings in `hotspot.c`, `usb_com.c`, `menuFirmwareInfoScreen.c`
- Automates codec blob generation so a fresh clone builds without manual steps

### 2. Multi-Variant Presets (`firmware/CMakePresets.json`)
Eight named presets covering all shipped configurations:

| Preset | Platform | 10W | Japanese |
|---|---|---|---|
| `mduv380` | MDUV380 | — | — |
| `mduv380-10w` | MDUV380 | yes | — |
| `mduv380-ja` | MDUV380 | — | yes |
| `mduv380-10w-ja` | MDUV380 | yes | yes |
| `dm1701` | DM1701 | — | — |
| `dm1701-ja` | DM1701 | — | yes |
| `rt84` | RT84 | — | — |
| `rt84-ja` | RT84 | — | yes |

Build a variant locally:
```sh
cmake --preset mduv380          # configure
cmake --build --preset mduv380  # build
```

### 3. GitHub Actions CI (`.github/workflows/build.yml`)
- All 8 presets run in parallel (`fail-fast: false`)
- Installs `gcc-arm-none-eabi`, `libnewlib-arm-none-eabi`, `cmake` via apt
- Uploads `WaveForge_*.bin` + `WaveForge.hex` per variant as 30-day artifacts
- Triggers on push/PR to `main` when `firmware/**` or the workflow itself changes

### 4. Artifact Naming
All output binaries use the `WaveForge_` prefix (e.g. `WaveForge_MDUV380.bin`).
The raw `WaveForge.bin`/`.hex` are also uploaded for debug/flashing convenience.

---

## Session 2 — 2026-04-24: Codec Donor Workflow, Flashing, and WaveForge Branding

### 1. Codec Donor Workflow

The real AMBE codec blob cannot be committed to the repo, but can be extracted from
a donor device (radio running official or OpenGD77 firmware) using `codec_cleaner`:

```sh
# Extract from a donor binary (e.g. an official factory .bin you legally own)
firmware/tools/codec_cleaner.Linux -e <donor_firmware.bin> \
    firmware/application/source/linkerdata/codec_bin_section_1.bin
```

Once extracted, place the file at:
`firmware/application/source/linkerdata/codec_bin_section_1.bin`

Then re-run CMake configure — the generated `codec_bin_generated.S` will pick up the
real blob automatically (it uses an absolute path injected at configure time).

**Verification:** After flashing, key up on a DMR channel. You should hear encoded
audio. The zero-filled placeholder firmware links and boots but produces no audio.

### 2. Flashing via usbipd / WSL2

Because the ST-Link interface is a USB device, it must be forwarded into WSL2 before
`openocd` or `st-flash` can see it. One-time setup (Windows PowerShell, elevated):

```powershell
# Install usbipd-win if not already present (winget or GitHub releases)
winget install usbipd

# List attached USB devices to find the ST-Link bus ID (e.g. 2-3)
usbipd list

# Bind once (persists across reboots)
usbipd bind --busid 2-3

# Attach to WSL each session
usbipd attach --wsl --busid 2-3
```

Inside WSL2 (after attach):

```sh
# Confirm the device appears
lsusb | grep -i stlink

# Flash using st-flash (install: sudo apt install stlink-tools)
st-flash write firmware/build/mduv380/WaveForge_MDUV380.bin 0x800C000

# Or via OpenOCD (config file exists at firmware/MDUV380_firmware.cfg)
openocd -f firmware/MDUV380_firmware.cfg \
        -c "program firmware/build/mduv380/WaveForge_MDUV380.bin verify reset exit"
```

**Note:** The flash address `0x800C000` is the application start — do not flash to
`0x8000000` or you will overwrite the bootloader.

### 3. WaveForge Branding Changes (committed as `825e2fa`)

Three source changes in `firmware/application/source/user_interface/`:

| File | Change |
|---|---|
| `uiSplashScreen.c` | Boot splash `"OpenGD77"` → `"WaveForge"` |
| `menuFirmwareInfoScreen.c` | Firmware info radio model label → `"WaveForge"` |
| `menuFirmwareInfoScreen.c` | Credits roll: added `"-- WaveForge --"` and `"Alex W0PWR"` |

---

## The Codec Binary Situation

This is the trickiest part of the build. Read carefully.

### What it is
`codec_bin_section_1.bin` is a **proprietary DMR AMBE codec binary blob** that gets
placed at a fixed absolute flash address `0x807537C`. The linker script creates a
custom section `.codec_bin_section_1` mapped to that exact address.

### The problem with the original source
The original `firmware/application/source/dmr_codec/codec_bin.S` uses a path
**relative to the Eclipse build output directory**:
```asm
.incbin "../application/source/linkerdata/codec_bin_section_1.bin"
```
This breaks for any non-Eclipse build location.

### How we solved it
CMake generates a replacement `.S` file at configure time with an **absolute path**
(`firmware/build/<preset>/codec_bin_generated.S`), and runs `codec_cleaner -C` to
produce a zero-filled placeholder blob if the real blob is absent.

### Where to find the real blob
- **Placeholder (what CI uses):** auto-generated by `firmware/tools/codec_cleaner.Linux -C`
  → produces an all-zeros `codec_bin_section_1.bin` (audio will not work, but firmware links)
- **Real blob location in source tree:** `firmware/application/source/linkerdata/codec_bin_section_1.bin`
  (this directory has a `readme.txt` explaining it; the file itself is **not committed** — it's gitignored or simply absent)
- **How to get the real blob:** Run `codec_cleaner -C` in the linkerdata directory, OR
  extract it from an official OpenGD77 / factory firmware binary using `codec_cleaner`
  in extract mode. The `codec_cleaner` tools for all platforms live at:
  - Linux:   `firmware/tools/codec_cleaner.Linux`
  - Windows: `firmware/tools/codec_cleaner.exe`
  - macOS:   `firmware/tools/codec_cleaner` (no extension)

### Key constraints — do not break these
- Fixed flash address `0x807537C` — hardcoded in the linker script. Never move it.
- `codec_interface.c` must be compiled with `-O0`. It contains timing-sensitive
  codec interface code that breaks under optimization.
- The generated `.S` file (`codec_bin_generated.S`) lives in the **build directory**,
  not the source tree. The original `codec_bin.S` in the source tree is **not used**
  by the CMake build — it remains there only as reference.

---

## Roadmap

### Near-term (build system / infrastructure)
- [ ] **Verify CI passes end-to-end** — confirm all 8 matrix jobs go green
  (toolchain install + configure + build + artifact upload).
- [ ] **Real codec blob in CI** — currently CI uses the zero-filled placeholder.
  Supply the real blob via a GitHub Actions secret + a pre-configure script to
  produce flashable artifacts from CI.
- [ ] **Remaining 10 Eclipse build variants** — the 18 Eclipse configs include
  hardware sub-variants (V1/V2/V4/V5) and debug builds not yet covered by the 8
  CMake presets. Each needs additional `PLATFORM_VARIANT_*` defines wired through
  CMake options.
- [ ] **Flash/debug CMake targets** — OpenOCD config (`MDUV380_firmware.cfg`) exists
  but isn't wired into CMake. Add `flash` and `debug` targets using the usbipd/WSL
  workflow documented above.
- [ ] **Windows/macOS local build docs** — the toolchain file assumes the
  cross-compiler is on `PATH`. Document or auto-detect common install paths.
- [ ] **Update README** — still references the original OpenGD77 project.

### Software / firmware
- [ ] **CPS (Code Plug Software)** — update or rebuild the Code Plug Software for
  WaveForge. The existing CPS references OpenGD77 branding and may have protocol
  assumptions tied to upstream. Goal: a WaveForge-branded CPS that works out of the
  box with WaveForge firmware.
- [ ] **FreeRTOS update** — bring FreeRTOS to the current upstream release. Audit
  the BSP tick config, heap scheme, and any OpenGD77-specific patches before merging.
- [ ] **STM32 HAL driver updates** — update STM32 HAL/LL drivers to a recent STM32CubeF4
  release. Watch for conflicts in the clock config and USB driver.
- [ ] **Python tools — Python 3 audit** — inventory all Python scripts under
  `firmware/tools/` and the CPS. Port anything still on Python 2 and pin minimum
  version to 3.10+.

### Community
- [ ] **Community outreach** — post to relevant DMR/ham radio forums and subreddits
  to attract contributors. Write a CONTRIBUTING.md, set up GitHub Discussions, and
  document the codec donor workflow so newcomers can build a working image.

---

## Key File Locations

| What | Where |
|---|---|
| CMake entry point | `firmware/CMakeLists.txt` |
| Build presets | `firmware/CMakePresets.json` |
| Toolchain file | `firmware/cmake/arm-none-eabi.cmake` |
| Linker script (flash) | `firmware/STM32F405VGTX_FLASH.ld` |
| CI workflow | `.github/workflows/build.yml` |
| Codec blob assembly | `firmware/application/source/dmr_codec/codec_bin.S` (original, unused by CMake) |
| Codec cleaner tools | `firmware/tools/codec_cleaner{,.Linux,.exe}` |
| Codec blob placeholder dir | `firmware/application/source/linkerdata/` |
| Generated codec `.S` (build-time) | `firmware/build/<preset>/codec_bin_generated.S` |
