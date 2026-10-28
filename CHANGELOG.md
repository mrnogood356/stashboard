# Changelog

## [1.1.1](https://github.com/mrnogood356/stashboard/compare/v1.1.0...v1.1.1) (2026-10-28)


### Bug Fixes

* **deps:** patched undici and multer ([aca2d44](https://github.com/mrnogood356/stashboard/commit/aca2d445b7c21449af8d835ef18d6e5f48df25d9))
* **deps:** patched undici and multer ([99997d9](https://github.com/mrnogood356/stashboard/commit/99997d95bfbd7bd066cf9158e844efb44438eb9e))

## [1.1.0](https://github.com/mrnogood356/stashboard/compare/v1.0.2...v1.1.0) (2026-10-28)


### Features

* catalog search fallback, catalog studio links, lighter app, hide scenes you have ([b0b47ac](https://github.com/mrnogood356/stashboard/commit/b0b47ac220a54f159e121f7cb8196c9bcddd3617))
* **catalog:** hide scenes you already have ([7e143a9](https://github.com/mrnogood356/stashboard/commit/7e143a9d485bfdcdf07ce8376920bd9af96750cd))
* **releases:** search Prowlarr when Whisparr finds nothing ([e52b90b](https://github.com/mrnogood356/stashboard/commit/e52b90ba5a6a4db876f820ced4813e55a8a3f03b))
* **web:** say on Search when the catalog couldn't be searched ([aa4798f](https://github.com/mrnogood356/stashboard/commit/aa4798f2ac08e85bf830e1f274368156b8aebca1))
* **web:** studios on catalog scenes open the studio on the catalog ([260dae1](https://github.com/mrnogood356/stashboard/commit/260dae15a3f036f81abd56211b63ce37331bc958))


### Bug Fixes

* address review on catalog search, studio links and pauses ([25a7896](https://github.com/mrnogood356/stashboard/commit/25a7896a0af9536169b952bf46692e8bf36086bd))
* **api:** catalog limiter only waits when a server asks ([e031fc7](https://github.com/mrnogood356/stashboard/commit/e031fc7d898abc5110cdbaee60c93ff27f08d6f4))
* **api:** lighter catalog limiter, only what the servers ask ([ce970b5](https://github.com/mrnogood356/stashboard/commit/ce970b55de9831f729268f7f76a7eaa1bd5fec1f))
* **catalog:** keep searching when the catalog's search fails on its side ([a59c5f9](https://github.com/mrnogood356/stashboard/commit/a59c5f92afd97e1086d7faee97dc75d0cb6a7af2))
* **catalog:** keep StashDB and FansDB requests polite ([4f14709](https://github.com/mrnogood356/stashboard/commit/4f14709c4ca2987beb3263372e41149205b1d1c5))
* **downloads:** bring in every video of a finished download, and tidy emptied folders ([587637b](https://github.com/mrnogood356/stashboard/commit/587637b6a405f2f49b2ad6455d05a0c64f363999))
* **downloads:** bring in every video of a finished download, and tidy emptied folders ([6063446](https://github.com/mrnogood356/stashboard/commit/60634464042dd32595a2ec3b5d144ab878b394c4))
* **drop-ins:** quieter extras, fair sweep, per-catalog refusals ([b02d582](https://github.com/mrnogood356/stashboard/commit/b02d582f524b8ee5aeb2eb16fb17e198fd7dda6e))
* **web:** even Settings groups, three sections each ([145d4ee](https://github.com/mrnogood356/stashboard/commit/145d4eea177d022421779795732c52ea55f99a9f))


### Performance Improvements

* gzip responses and card-size studio logos ([eb41e7b](https://github.com/mrnogood356/stashboard/commit/eb41e7b820d3dcd3dae619329d5de7c496619964))

## [1.0.2](https://github.com/mrnogood356/stashboard/compare/v1.0.1...v1.0.2) (2026-10-23)


### Bug Fixes

* **downloads:** don't wait again for a scan another file is waiting on ([4a95f31](https://github.com/mrnogood356/stashboard/commit/4a95f31b292684ba7b50cefd8f65b5dfb0778f9e))
* **organizer:** never clean up the downloads destination; add folders to keep ([c4544e4](https://github.com/mrnogood356/stashboard/commit/c4544e4dee71114af33c16925ac1b1427007ee25))
* **organizer:** never clean up the downloads destination; add folders to keep ([0c9e7a9](https://github.com/mrnogood356/stashboard/commit/0c9e7a93b37cc3c25160418baf216236a2637b69))
* **stash:** stop queuing the same Stash job again while it waits ([e5402e1](https://github.com/mrnogood356/stashboard/commit/e5402e1965ec8ec71d948dea5bbb0bd884a08b9e))
* **stash:** stop queuing the same Stash job again while it waits ([f1a9ce0](https://github.com/mrnogood356/stashboard/commit/f1a9ce0f730a7217d62644e8d85ab5ffc68c6a6e))

## [1.0.1](https://github.com/mrnogood356/stashboard/compare/v1.0.0...v1.0.1) (2026-10-22)


### Bug Fixes

* **api:** drop bracketed groups from release titles in one pass ([99295b8](https://github.com/mrnogood356/stashboard/commit/99295b82c938d5e8dcbc48ef42977cd30fa7a9ad))
* **api:** drop bracketed groups from release titles in one pass ([4c2ba52](https://github.com/mrnogood356/stashboard/commit/4c2ba52bdc86bbb402fc8a34e462f7ad7277262d))
* **api:** trim path separators and quotes without backtracking regexes ([7ccf545](https://github.com/mrnogood356/stashboard/commit/7ccf545c88679955594361b30d7a0074ed0aca4d))
* **api:** trim path separators and quotes without backtracking regexes ([9e69bf9](https://github.com/mrnogood356/stashboard/commit/9e69bf95879dad7d22cad41ebc0dc44818dd1743))

## [1.0.0](https://github.com/mrnogood356/stashboard/compare/v0.2.0...v1.0.0) (2026-10-22)


### Features

* **api:** keep-me-signed-in sessions and Face ID sign-in ([5427cb8](https://github.com/mrnogood356/stashboard/commit/5427cb8c7f53c3ac21ef0016a3cd1abf177097d2))
* **downloads:** bring in SABnzbd jobs added by hand to Stashboard's category ([6754ea1](https://github.com/mrnogood356/stashboard/commit/6754ea1aed8960c73064c8722ff0a4f00540911d))
* **downloads:** bring in SABnzbd jobs added by hand to Stashboard's category ([fd85d04](https://github.com/mrnogood356/stashboard/commit/fd85d044e52a938226e028a6208351b83f9e03bd))
* new icon, and the two dependency updates Dependabot couldn't make ([e769e92](https://github.com/mrnogood356/stashboard/commit/e769e92a79580bc2e20b0ec8be958675614ec76c))
* redesigned sign-in with keep-me-signed-in and Face ID ([020902f](https://github.com/mrnogood356/stashboard/commit/020902fe821ce83a177f4049fc137218bc6791f5))
* Stashboard ([c54c967](https://github.com/mrnogood356/stashboard/commit/c54c96753f6e75876a76fdf70d0c607f423e323c))
* **web:** add See all links to search result sections ([2c3c36d](https://github.com/mrnogood356/stashboard/commit/2c3c36da54c1cf53ef40b12889c38f103a5fe270))
* **web:** new Stashboard icon ([e5541e9](https://github.com/mrnogood356/stashboard/commit/e5541e9854b5b8e6ab41e90d83206f0d3a61f593))
* **web:** redesign the sign-in and first-run pages ([5bef6cf](https://github.com/mrnogood356/stashboard/commit/5bef6cfcc4a95f8576715811c4399eb3e30610a8))
* **web:** replace the settings tab row with a grouped section picker ([bfc3c78](https://github.com/mrnogood356/stashboard/commit/bfc3c789a88007e122d08935689a6b4c14175317))
* **web:** Settings opens on grouped cards like Library tools ([8c5fd68](https://github.com/mrnogood356/stashboard/commit/8c5fd68526dcc889b62449465ce66cf4f5e9e40b))
* **web:** Settings opens on grouped cards like Library tools ([8383be7](https://github.com/mrnogood356/stashboard/commit/8383be74c7fefd7f7e7ead4af1b7128d7c236ae3))
* **web:** switch and label for downloads added in SABnzbd ([6cdc83e](https://github.com/mrnogood356/stashboard/commit/6cdc83e99825d0ae10251e17647620a8b4a931e7))


### Bug Fixes

* **downloads:** retry failed identification and page SABnzbd history for manual jobs ([dd2eb49](https://github.com/mrnogood356/stashboard/commit/dd2eb49f6c6e5081ed95895601df2a9463217403))
* **web:** theme native select option lists and use p-select for acquisition sort ([acbce8c](https://github.com/mrnogood356/stashboard/commit/acbce8c5af172c317caefb7487008c79a18b6315))
* **web:** themed dropdowns, settings section picker, search "See all" ([0df44ff](https://github.com/mrnogood356/stashboard/commit/0df44ff250338a0af5a19d72fb78f490b96b3837))
* **web:** use the app icon for the sidebar logo ([c3a15b5](https://github.com/mrnogood356/stashboard/commit/c3a15b50b31c2b8ca749f67c713527b7ba40a6bb))
* **web:** use the app icon for the sidebar logo ([b8b7630](https://github.com/mrnogood356/stashboard/commit/b8b76301608a567c6b808d60938e8c570e8542bc))

## Changelog
