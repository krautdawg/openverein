#!/usr/bin/env bash
# Validates the sample XRechnung files with the official KoSIT validator and the XRechnung configuration.
# Needs Java 17+ (or Docker). Downloads both into .kosit/ on first run.
set -euo pipefail
cd "$(dirname "$0")/.."
VALIDATOR=1.6.3
CONFIG=v2026-08-31
CONFIG_ZIP=xrechnung-3.0.2-validator-configuration-2026-08-31.zip
mkdir -p .kosit
[ -f .kosit/validator.jar ] || curl -sSL -o .kosit/validator.jar "https://github.com/itplr-kosit/validator/releases/download/v${VALIDATOR}/validator-${VALIDATOR}-standalone.jar"
[ -d .kosit/conf ] || { curl -sSL -o .kosit/conf.zip "https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/${CONFIG}/${CONFIG_ZIP}" && mkdir -p .kosit/conf && unzip -qo .kosit/conf.zip -d .kosit/conf; }
rm -rf .kosit/samples && node scripts/xrechnung-samples.ts .kosit/samples
if command -v java >/dev/null; then
  java -jar .kosit/validator.jar -s .kosit/conf/scenarios.xml -r .kosit/conf -o .kosit/report .kosit/samples/*.xml
else
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/.kosit:/k" -w /k eclipse-temurin:17-jre java -jar /k/validator.jar -s /k/conf/scenarios.xml -r /k/conf -o /k/report $(cd .kosit && ls samples/*.xml | sed 's#^#/k/#')
fi
