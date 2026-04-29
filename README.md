# ClearDMR

Open source community firmware for the **Baofeng DM-1701**, **TYT MD-UV380**, and **Retevis RT84** digital radios.

**[cleardmr.com](https://cleardmr.com)** — Web Flasher • Setup Guide • Web CPS

ClearDMR is a community-driven continuation and **fork** of the OpenGD77 firmware project, modernized and maintained for ongoing use by amateur radio operators worldwide.

---

## ⚠️ Disclaimer

This firmware is provided **as-is** with no warranty of any kind. Flashing
third-party firmware to your radio is done entirely at your own risk. The
ClearDMR contributors are not responsible for any damage to your equipment,
unauthorized transmissions, or any regulatory violations. Always ensure you
are operating within the laws and license conditions of your country.

**This project is for amateur radio and research use only. Commercial use is
strictly prohibited per the original license.**

---

## Supported Hardware

| Radio           | Variants              | Status      |
| --------------- | --------------------- | ----------- |
| Baofeng DM-1701 | Standard, Japan       | ✅ Supported |
| TYT MD-UV380    | Standard, 10W+, Japan | ✅ Supported |
| Retevis RT84    | Standard, Japan       | ✅ Supported |

All variants share the same STM32F405 processor and are flashed using the
[Web Flasher](https://cleardmr.com).

---

## Project Status

**ClearDMR v1.0.0 released.**

### Completed

* ✅ CMake build system — all 8 firmware variants building cleanly
* ✅ GitHub Actions CI/CD with automatic releases
* ✅ Web flasher live at [cleardmr.com](https://cleardmr.com)
* ✅ Baofeng DM-1701, TYT MD-UV380, and Retevis RT84 support

### In Progress

* 🔄 Web-based CPS (codeplug editor) at [cleardmr.com/cps](https://cleardmr.com/cps)

  * Browser-based radio read via Web Serial
  * Live codeplug interaction without desktop software

### Roadmap

* 📋 FreeRTOS update
* 📋 STM32 HAL driver updates
* 📋 Additional radio support

---

## Flashing

The easiest way to flash ClearDMR is through the browser-based Web Flasher —
no software to install, works on Windows, macOS, and Linux.

**[cleardmr.com](https://cleardmr.com)**

Requires Chrome 89+ or Edge 89+ (WebUSB/Web Serial). Windows users need a one-time
WinUSB driver swap via [Zadig](https://zadig.akeo.ie) — full instructions
are on the site.

---

## Background

ClearDMR is a community-driven continuation and fork of the
[OpenGD77](https://www.opengd77.com) firmware (September 2024),
originally developed by Roger Clark VK3KYY and contributors.

OpenGD77 entered archive/read-only status in 2026. ClearDMR exists
to carry that work forward for the community.

ClearDMR is an independent project and is not affiliated with or
endorsed by the original OpenGD77 developers.

All original copyright notices are preserved in accordance with the
OpenGD77 license terms.

---

## Contributing

Contributions are welcome. Whether you own one of the supported radios,
have embedded C experience, or just want to test and report bugs —
there's a place for you here.

Please open an **Issue** before submitting large changes so we can
discuss approach first.

---

## License

ClearDMR is a derivative work of the OpenGD77 firmware and is distributed
under the same license terms. See [LICENSE](LICENSE) for full details.

**Non-commercial use only.**
