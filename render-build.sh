#!/bin/bash
set -e
echo "Installing Puppeteer dependencies..."
apt-get update
apt-get install -y ca-certificates fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libgbm1 libnss3 libx11-6 libxcomposite1
echo "Done"
