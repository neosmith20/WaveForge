# Contributing to ClearDMR

Thanks for your interest in contributing to ClearDMR! 🎉

This project is a community-driven continuation of OpenGD77, and contributions of all kinds are welcome.

---

## Getting Started

Before contributing, please:

* Read the [README](README.md)
* Check existing **Issues** to avoid duplicates
* Open an **Issue** first for large changes or new features

---

## Ways to Contribute

You don’t need to be a firmware expert to help.

### 🐞 Bug Reports

If something isn’t working:

Please include:

* What you expected to happen
* What actually happened
* Steps to reproduce the issue
* Logs or screenshots (if applicable)
* Your radio model (DM-1701, MD-UV380, RT84, etc.)

For Web CPS issues, include:

* Browser (Chrome, Edge, version)
* Whether Web Serial or WebUSB was used

---

### 💡 Feature Requests

Have an idea?

* Open an **Issue**
* Clearly describe the feature
* Explain why it would be useful

Please avoid submitting large feature pull requests without discussion first.

---

### 🔧 Code Contributions

If you want to contribute code:

1. Fork the repository
2. Create a new branch
3. Make your changes
4. Test thoroughly
5. Submit a Pull Request

---

## Important Guidelines

### Keep Changes Focused

* One feature or fix per pull request
* Avoid large unrelated changes

---

### Do Not Break Compatibility

ClearDMR maintains compatibility with OpenGD77 firmware and codeplug formats.

* Do not change protocol structures without discussion
* Do not rename or alter required format identifiers (e.g., "OpenGD77")

---

### Web CPS / Serial Changes

Changes involving Web Serial or WebUSB must be handled carefully:

* Do not introduce unsafe read/write behavior
* Ensure partial reads are handled correctly
* Avoid changes that could corrupt radio data

---

### Testing

Before submitting:

* Test on actual hardware if possible
* Verify reads/writes do not corrupt data
* Confirm behavior across supported radios when applicable

---

## Security

If your contribution relates to a security issue:

**Do not open a public issue.**

See [SECURITY.md](SECURITY.md) for reporting instructions.

---

## Code Style

* Keep code readable and consistent with existing style
* Avoid unnecessary complexity
* Comment where needed (especially protocol handling code)

---

## License

By contributing, you agree that your contributions will be licensed under the same terms as the project.

ClearDMR is based on OpenGD77 and remains **non-commercial**.

---

## Final Notes

This project is actively maintained by a small team (currently one developer), so:

* Reviews may take time
* Feedback may be direct (don’t take it personally 🙂)

We appreciate your help in keeping ClearDMR stable, reliable, and useful for the community.

---
