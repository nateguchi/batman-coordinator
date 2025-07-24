#!/bin/bash
# Quick fix for wireless interface issues
# Usage: sudo ./fix-wireless.sh [interface] [ssid] [frequency]

INTERFACE=${1:-wlan0}
SSID=${2:-batman-mesh}
FREQ=${3:-2437}

echo "=== Wireless Interface Reset Tool ==="
echo "Interface: $INTERFACE"
echo "SSID: $SSID" 
echo "Frequency: $FREQ MHz"
echo "=================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (use sudo)"
   exit 1
fi

echo "Step 1: Stopping conflicting services..."
# Check if NetworkManager exists and is running
if systemctl is-active --quiet NetworkManager; then
    echo "Stopping NetworkManager..."
    systemctl stop NetworkManager
else
    echo "NetworkManager not running"
fi

# Kill wpa_supplicant if running
pkill wpa_supplicant 2>/dev/null && echo "Killed wpa_supplicant" || echo "wpa_supplicant not running"

# Take control from NetworkManager if nmcli exists
if command -v nmcli >/dev/null 2>&1; then
    nmcli device set $INTERFACE managed no 2>/dev/null && echo "Set interface unmanaged" || true
fi

echo "Step 2: Disconnecting from existing networks..."
iw $INTERFACE disconnect 2>/dev/null
iw $INTERFACE ibss leave 2>/dev/null

echo "Step 3: Resetting interface..."
ip link set $INTERFACE down
rfkill unblock wifi
sleep 2

echo "Step 4: Bringing interface up..."
ip link set $INTERFACE up
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to bring interface up"
    exit 1
fi

echo "Step 5: Setting IBSS mode..."
iw $INTERFACE set type ibss
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set IBSS mode"
    echo "Interface may not support ad-hoc mode"
    exit 1
fi

echo "Step 6: Joining IBSS network..."
iw $INTERFACE ibss join $SSID $FREQ
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to join IBSS network"
    echo "Trying alternative frequencies..."
    
    # Try different frequencies
    for alt_freq in 2462 2437 2412 2442; do
        if [ $alt_freq -ne $FREQ ]; then
            echo "Trying frequency $alt_freq MHz..."
            iw $INTERFACE ibss join $SSID $alt_freq
            if [ $? -eq 0 ]; then
                echo "SUCCESS: Joined on frequency $alt_freq MHz"
                break
            fi
        fi
    done
fi

echo "=== Final Status ==="
echo "Interface information:"
iw $INTERFACE info

echo ""
echo "Link status:"
iw $INTERFACE link

echo ""
echo "Available networks:"
iw $INTERFACE scan | grep -E "(BSS|SSID)" | head -10

echo ""
echo "If still having issues, check:"
echo "1. dmesg | tail -20"
echo "2. journalctl -u NetworkManager | tail -10" 
echo "3. lsmod | grep mac80211"
echo "4. rfkill list"
