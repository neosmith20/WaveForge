# ClearDMR

Open source firmware for the **Baofeng DM-1701** and **TYT MD-UV380** digital radios.

ClearDMR is a community-driven continuation of the OpenGD77 firmware project, 
modernized and maintained for ongoing use by amateur radio operators worldwide.

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

| Radio | Status |
|-------|--------|
| Baofeng DM-1701 | ✅ Primary target |
| TYT MD-UV380 | ✅ Supported |

---

## Project Status

ClearDMR is in early development. Current focus:

- [ ] Modernizing the build system (migrating from Eclipse CDT to CMake)
- [ ] Verifying clean build on current toolchains
- [ ] Updating FreeRTOS to current version
- [ ] Python tool compatibility with Python 3
- [ ] Establishing GitHub Actions CI/CD (automatic builds)

---

## Background

ClearDMR is based on the final release of the 
[OpenGD77](https://www.opengd77.com) firmware (September 2024), 
originally developed by Roger Clark VK3KYY and contributors. 
OpenGD77 entered archive/read-only status in 2026. ClearDMR exists 
to carry that work forward for the community.

All original copyright notices are preserved in accordance with the 
OpenGD77 license terms.

---

## Contributing

Contributions are very welcome! Whether you own one of the supported 
radios, have embedded C experience, or just want to test and report 
bugs — there's a place for you here.

Please open an **Issue** before submitting large changes so we can 
discuss approach first.

---

## License

ClearDMR is released under the same terms as the original OpenGD77 
firmware. See [LICENSE](LICENSE) for full details.

**Non-commercial use only.**
