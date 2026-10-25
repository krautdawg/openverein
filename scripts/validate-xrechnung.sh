#!/usr/bin/env bash
# Validates the sample XRechnung files with the official KoSIT validator and the XRechnung configuration.
# Needs Java 17+ (or Docker). Downloads both into .kosit/ on first run.
set -euo pipefail
cd "$(dirname "$0")/.."
VALIDATOR=1.6.3
CONFIG=v2026-08-31
CONFIG_ZIP=xrechnung-3.0.2-validator-configuration-2026-08-31.zip
mkdir -p .kosit
[ -f .kosit/validator.jar ] || curl -fsSL -o .kosit/validator.jar "https://github.com/itplr-kosit/validator/releases/download/v${VALIDATOR}/validator-${VALIDATOR}-standalone.jar"
[ -f .kosit/conf.zip ] || curl -fsSL -o .kosit/conf.zip "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/${CONFIG}/${CONFIG_ZIP}"
# Pinned downloads: a changed file stops the run.
printf '%s  %s\n' 799e64befca97d4080e03608c80b85dd5a5ecc5f4ae4f35d1116ec2855b9a7c9 .kosit/validator.jar 2530cd107c414511c5d0462ec10f886910395abfca820db82e83d70bf01221a8 .kosit/conf.zip | sha256sum -c --quiet
[ -d .kosit/conf ] || { mkdir -p .kosit/conf && unzip -qo .kosit/conf.zip -d .kosit/conf; }
rm -rf .kosit/samples && node scripts/xrechnung-samples.ts .kosit/samples
if command -v java >/dev/null; then
  java -jar .kosit/validator.jar -s .kosit/conf/scenarios.xml -r .kosit/conf -o .kosit/report .kosit/samples/*.xml
else
  # shellcheck disable=SC2046 # one argument per sample file is intended
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/.kosit:/k" -w /k eclipse-temurin:17-jre java -jar /k/validator.jar -s /k/conf/scenarios.xml -r /k/conf -o /k/report $(cd .kosit && ls samples/*.xml | sed 's#^#/k/#')
fi
