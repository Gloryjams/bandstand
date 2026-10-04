# Security

## Reporting a problem

If you find a security problem in Bandstand, please report it privately, not in a
public issue.

Use GitHub's private reporting form: open
<https://github.com/gloryjams/bandstand/security/advisories/new>, or go to the
**Security** tab of the repository and choose **Report a vulnerability**. Only the
maintainers can read what you send there.

Please include:

- what an attacker could do, and what they need first (a member key, the director
  key, nothing at all)
- the steps to show it, on a test install, never on somebody else's server
- the Bandstand version, from `/api/health`

You will get an answer within a week. Bandstand is maintained by one person, so a
fix can take longer than that, and you will be told the plan. When a fix is
released, the release notes say so, and you are credited unless you would rather
not be.

## Supported versions

Bandstand is in public beta. Only the newest release gets security fixes. The
version you run is shown at `/api/health`; how to update is in
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#update).

## What is in scope

The Bandstand server, the app, the share pages and rehearsal rooms, the Docker
image and the compose file in this repository.

Your own server's setup is yours: the computer it runs on, your network, a
reverse proxy or tunnel you put in front of it. The guide's advice for running
Bandstand outside your home is under "Reaching Bandstand from outside your home".
