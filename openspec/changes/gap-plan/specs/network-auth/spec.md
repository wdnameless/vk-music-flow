# Network and auth recovery

## ADDED Requirements

### Requirement: VK calls recover from expired tokens and captchas
The API client SHALL re-mint the token on auth failure regardless of which
attempt it happens on, and SHALL surface captcha (14) and validation (17)
as explicit recoverable states instead of silent failures.

#### Scenario: Auth failure after a transport retry still recovers
- **WHEN** the token expires on a retry that follows a transport failure
- **THEN** the client mints a fresh token once and repeats the call.

#### Scenario: Captcha is explicit
- **WHEN** VK answers with error code 14
- **THEN** the call resolves with a needsCaptcha state instead of dropping.

### Requirement: Proxy authentication is bounded and honest
The proxy layer SHALL match auth challenges against the challenger, SHALL
stop after a bounded run of 407 rejections, and the liveness probe SHALL
report proxy errors (407/502) as failures.

#### Scenario: Wrong proxy credentials stop cleanly
- **WHEN** the proxy rejects credentials repeatedly
- **THEN** the client stops challenging, marks the entry failed, and reports
  the proxy error to the user.

### Requirement: Artist blocking matches whole names
The block filter SHALL match whole normalized artist names, not substrings.

#### Scenario: Partial name does not block
- **WHEN** the block list contains a short name
- **THEN** artists merely containing it keep playing.
