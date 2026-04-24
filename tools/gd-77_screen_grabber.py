#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Copyright (C) 2019-2024 Daniel Caujolle-Bert, F1RMB
                        Roger Clark, VK3KYY / G4KYF

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer
   in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

4. Use of this source code or binary releases for commercial purposes is strictly forbidden. This includes, without limitation,
   incorporation in a commercial product or incorporation into a product or project which allows commercial use.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

####################################################################################

You also need python3-serial
On Fedora you need to install python3-pyserial.noarch (sudo dnf install python3-pyserial.noarch)
On archLinux, you need to install python3, pip, and some python packages (pacman -S python-pip && pip install --user pyserial pillow cimage)

On windows install pyserial, pillow and cimage (using pip install ...)
"""

from datetime import datetime
import time
import os.path
import ntpath
import getopt, sys
import serial
import platform
from ctypes import *
import enum
from PIL import Image
from PIL import ImageDraw, ImageColor


imgBuffer = [0x0] * 1024
MAX_TRANSFER_SIZE = 1024

# Default values
DEFAULT_SCALE = 2
DEFAULT_FOREGROUND = "#000000"
DEFAULT_BACKGROUND = "#99d9ea"
##
PROGRAM_VERSION = '0.0.4'

PlatformsNames = [ "GD-77", "GD-77S", "DM-1801", "RD-5R", "DM-1801A", "MD-9600", "MD-UV380", "MD-380", "DM-1701", "MD-2017", "DM-1701 (RGB)" ]

class PlatformModels(enum.Enum):
    PLATFORM_UNKNOWN = -1
    PLATFORM_GD77 = 0
    PLATFORM_GD77S = 1
    PLATFORM_DM1801 = 2
    PLATFORM_RD5R = 3
    PLATFORM_DM1801A = 4
    PLATFORM_MD9600 = 5
    PLATFORM_MDUV380 = 6
    PLATFORM_MD380 = 7
    PLATFORM_DM1701_BGR = 8
    PLATFORM_MD2017 = 9
    PLATFORM_DM1701_RGB = 10

    def __int__(self):
        return self.value

class RadioInfoFeatures(enum.Enum):
    SCREEN_INVERTED = (1 << 0)
    DMRID_USES_VOICE_PROMPTS = (1 << 1)
    VOICE_PROMPTS_AVAILABLE = (1 << 2)
    
    def __int__(self):
        return self.value
    
class RadioInfoStruct(Structure):
    _pack_ = 1
    _fields_ = [('structVersion', c_uint),
                ('radioType', c_uint),
                ('gitRevision', c_char * 16),
                ('buildDateTime', c_char * 16),
                ('flashId', c_uint),
                ('features', c_ushort)]

platformModel = PlatformModels.PLATFORM_UNKNOWN
radioInfo = None;

###
#
###
def sendCommand(ser, command, x_or_command_option_number=0, y=0, iSize=0, alignment=0, isInverted=0, message=""):
    sendbuffer = [0x0] * 64
    readbuffer = [0x0] * 64
    radioInfoReceived = False
    totalLength = 0
    radioInfoBuffer = []
    bytesToSend = 2

    sendbuffer[0] = ord('C')
    sendbuffer[1] = command

    if (command == 2):
        sendbuffer[3] = y
        sendbuffer[4] = iSize
        sendbuffer[5] = alignment
        sendbuffer[6] = isInverted
        bytesToSend += (5 + min([len(message), 16]))
        sendbuffer[7:] = str.encode(message)[0:(bytesToSend - 7)]
    elif (command == 6):
        #Special command
        sendbuffer[2] = x_or_command_option_number
        bytesToSend += 1;

    ser.flush()

    ret = ser.write(sendbuffer[0:bytesToSend])
    if (ret != bytesToSend):
        print("ERROR: write() wrote " + ret + " bytes")
        return False

    while (ser.in_waiting == 0):
        time.sleep(0.2)

    readbuffer = ser.read(ser.in_waiting)

    return (readbuffer[0] == command)

###
# Check feature bit from RadioInfo's feature
###
def RadioInfoIsFeatureSet(feature):
    v = int(radioInfo.features)
    f = int(feature)

    if ((v & f) != 0):
        return True

    return False

###
# Read the RadioInfo, then fill the global structure
###
def readRadioInfo(ser):
    DataModeReadRadioInfo = 9
    sendbuffer = [0x0] * 8
    readbuffer = [0x0] * 64
    radioInfoReceived = False
    totalLength = 0
    radioInfoBuffer = []
    size = 8

    ser.flush()

    print(" - read RadioInfo...")
    sendbuffer[0] = ord('R')
    sendbuffer[1] = DataModeReadRadioInfo
    sendbuffer[2] = 0
    sendbuffer[3] = 0
    sendbuffer[4] = 0
    sendbuffer[5] = 0
    sendbuffer[6] = ((size >> 8) & 0xFF);
    sendbuffer[7] = ((size >> 0) & 0xFF);

    ret = ser.write(sendbuffer)
    if (ret != 8):
        print("ERROR: write() wrote " + ret + " bytes")
        return False

    while (ser.in_waiting == 0):
        time.sleep(0.2)

    readbuffer = ser.read(ser.in_waiting)

    header = ord('R')

    if (readbuffer[0] == header):
        totalLength = (readbuffer[1] << 8) + (readbuffer[2] << 0)
        radioInfoBuffer[0:] = readbuffer[3:]

    else:
        return False

    if (totalLength > 0):
        ## Check about RadioInfo version and upgrade if possible
        ## Latest version is 0x03
        if (radioInfoBuffer[0] == 0x01):
            radioInfoBuffer += [0x00, 0x00] ## features set to 0
        elif (radioInfoBuffer[0] == 0x02):
            radioInfoBuffer += [0x00]; ## convert old screenInverted to features
            
        global radioInfo
        radioInfo = RadioInfoStruct.from_buffer(bytearray(radioInfoBuffer))

        ##print(radioInfoBuffer)
        #print("   * structVersion:", radioInfo.structVersion)
        #print("   * radioType:", radioInfo.radioType)
        #print("   * gitRevision:", radioInfo.gitRevision.decode("utf-8"))
        #print("   * buildDateTime:", radioInfo.buildDateTime.decode("utf-8"))
        #print("   * flashId:", hex(radioInfo.flashId))
        #print("   * features:", hex(radioInfo.features))

        global platformModel
        platformModel = PlatformModels(radioInfo.radioType)

        return True

    return False

###
# Send the command to the GD-77 and read buffer back
###
def sendAndReceiveCommand(ser):
    DataModeReadScreenGrab = 6
    sendbuffer = [0x0] * 8
    readbuffer = [0x0] * 64
    currentDataAddressInTheRadio = 0
    currentDataAddressInLocalBuffer = 0
    totalSize = 1024
    size = 1024
    progress = 0

    if (platformModel == PlatformModels.PLATFORM_MDUV380) or (platformModel == PlatformModels.PLATFORM_MD380) or (platformModel == PlatformModels.PLATFORM_DM1701_BGR) or (platformModel == PlatformModels.PLATFORM_DM1701_RGB) or (platformModel == PlatformModels.PLATFORM_MD2017):
        global imgBuffer
        totalSize = 160 * 128 * 2
        imgBuffer = [0x0] * totalSize

    ser.flush()

    #
    ##
    ##
    ##
    print(" - downloading from the {}...".format(PlatformsNames[int(platformModel)]))
    while (size > 0):
        if (size > MAX_TRANSFER_SIZE):
            size = MAX_TRANSFER_SIZE;

        sendbuffer[0] = ord('R')
        sendbuffer[1] = DataModeReadScreenGrab
        sendbuffer[2] = ((currentDataAddressInTheRadio >> 24) & 0xFF)
        sendbuffer[3] = ((currentDataAddressInTheRadio >> 16) & 0xFF)
        sendbuffer[4] = ((currentDataAddressInTheRadio >> 8) & 0xFF)
        sendbuffer[5] = ((currentDataAddressInTheRadio >> 0) & 0xFF)
        sendbuffer[6] = ((size >> 8) & 0xFF);
        sendbuffer[7] = ((size >> 0) & 0xFF);

        ret = ser.write(sendbuffer)
        if (ret != 8):
            print("ERROR: write() wrote " + ret + " bytes")
            return False

        while (ser.in_waiting == 0):
            time.sleep(0.2)

        readbuffer = ser.read(ser.in_waiting)

        header = ord('R')

        if (readbuffer[0] == header):

            l = (readbuffer[1] << 8) + (readbuffer[2] << 0)

            # something went wrong in the communication, keep the current data, flush the serial buffers
            if (l > (len(readbuffer) - 3)):
                ser.read(ser.in_waiting)
                ser.flush()
                ser.reset_input_buffer()
                l = len(readbuffer) - 3

            for i in range(0, l):
                imgBuffer[currentDataAddressInLocalBuffer] = readbuffer[i + 3]
                currentDataAddressInLocalBuffer += 1

            progress = currentDataAddressInTheRadio * 100 // totalSize
            print("\r - reading: " + str(progress) + "%", end='')
            sys.stdout.flush()

            currentDataAddressInTheRadio += l
        else:
            print("read stopped (error at " + str(currentDataAddressInTheRadio) + ")")

            return False

        size = totalSize - currentDataAddressInTheRadio

    print("\r - reading: 100%")
    return True


###
# Scale and save the downloaded image to a PNG file
###
def saveImage(filename, scale, foreground, background):
    width = 128
    height = 64

    if (platformModel == PlatformModels.PLATFORM_MDUV380) or (platformModel == PlatformModels.PLATFORM_MD380) or (platformModel == PlatformModels.PLATFORM_DM1701_BGR) or (platformModel == PlatformModels.PLATFORM_DM1701_RGB) or (platformModel == PlatformModels.PLATFORM_MD2017):
        width = 160
        height = 128
        img = Image.new('RGB', (width, height), background)
        # Drawing context
        d = ImageDraw.Draw(img)

        index = 0

        for y in range(0, height):
            for x in range(0, width):
                colour565 = (imgBuffer[index] << 8) + imgBuffer[index + 1];

                red = 0
                green = 0
                blue = 0

                # BGR565
                if (platformModel == PlatformModels.PLATFORM_DM1701_BGR):
                    red = ((colour565 & 0x1f) << 3)
                    green = ((colour565 & 0x7e0) >> 3)
                    blue = ((colour565 & 0xf800) >> 8)
                else: # RGB565
                    red = ((colour565 & 0xf800) >> 8)
                    green = ((colour565 & 0x7e0) >> 3)
                    blue = ((colour565 & 0x1f) << 3)

                if (RadioInfoIsFeatureSet(RadioInfoFeatures.SCREEN_INVERTED) == True): ## screen is Inverted
                    red = (0xff - red)
                    green = (0xff - green)
                    blue = (0xff - blue)

                d.point((x, y), (red, green, blue))
                index += 2;


    else: # 1-bit per pixel
        # Image (scale 1:1)
        img = Image.new('RGB', (width, height), background)
        # Drawing context
        d = ImageDraw.Draw(img)

        for stripe in range(0, 8):
            for column in range(0, width):
                for line in range(0, 8):
                    if (((imgBuffer[(stripe * width) + column] >> line) & 0x01) != 0):
                        d.point((column, stripe * 8 + line), foreground)


    print(" - saving " + filename + ".png")
    if (scale == 1):
        img.save(filename + '.png')
    else:
        rimg = img.resize((width * scale, height * scale), resample=Image.NEAREST)
        rimg.save(filename + '.png')


###
# Display command line options
###
def usage():
    print("GD-77 Screen Grabber v" + PROGRAM_VERSION)
    print("Usage:  " + ntpath.basename(sys.argv[0]) + " [OPTION]")
    print("")
    print("    -h, --help                 : Display this help text,")
    print("    -d, --device=<device>      : Use the specified device as serial port,")
    print("    -s, --scale=v              : Apply scale factor (1..x) [default: " + str(DEFAULT_SCALE) + "],")
    print("    -o, --output=<filename>    : Save the image in <filename>.png (without file extension),")
    print("    -f, --foreground=#RRGGBB   : Use specified color as foreground color [default: " + DEFAULT_FOREGROUND + "],")
    print("    -b, --background=#RRGGBB   : Use specified color as background color [default: " + DEFAULT_BACKGROUND + "].")
    print("")


###
# main function
###
def main():
    # Default tty
    if (platform.system() == 'Windows'):
        serialDev = "COM13"
    else:
        serialDev = "/dev/ttyACM0"

    scale = DEFAULT_SCALE
    foreground = DEFAULT_FOREGROUND
    background = DEFAULT_BACKGROUND
    dateTimeObj = datetime.now()
    timestampStr = dateTimeObj.strftime("%Y-%m-%d_%H_%M_%S")
    filename = "GD-77_screengrab-" + timestampStr

    # Command line argument parsing
    try:
        opts, args = getopt.getopt(sys.argv[1:], "hd:s:o:f:b:", ["help", "device=", "scale=", "output=", "foreground=", "background="])
    except getopt.GetoptError as err:
        print(str(err))
        usage()
        sys.exit(2)

    for opt, arg in opts:
        if opt in ("-h", "--help"):
            usage()
            sys.exit(2)
        elif opt in ("-d", "--device"):
            serialDev = arg
        elif opt in ("-s", "--scale"):
            scale = int(arg)
            if (scale < 1):
                scale = 1
        elif opt in ("-o", "--output"):
            filename = arg
        elif opt in ("-f", "--foreground"):
            # Check color validity
            try:
                rgb = ImageColor.getrgb(arg)
            except ValueError as err:
                print("Color '" + arg +"' is invalid")
                sys.exit(-3)

            foreground = arg
        elif opt in ("-b", "--background"):
            # Check color validity
            try:
                rgb = ImageColor.getrgb(arg)
            except ValueError as err:
                print("Color '" + arg +"' is invalid")
                sys.exit(-3)

            background = arg
        else:
            assert False, "Unhandled option"

    # Initialize Serial Port
    ser = serial.Serial()
    ser.port = serialDev
    ser.baudrate = 115200
    ser.bytesize = serial.EIGHTBITS
    ser.parity = serial.PARITY_NONE
    ser.stopbits = serial.STOPBITS_ONE
    ser.timeout = 1000.0
    #ser.xonxoff = 0
    #ser.rtscts = 0
    ser.write_timeout = 1000.0

    if (os.path.isfile(filename + ".png") == True):
        # Add timestamp to avoid file override
        print("WARNING: the file '" + filename + ".png' already exists. Image will be saved in '" + filename + "-" + timestampStr + ".png'.")
        filename += "-" + timestampStr

    try:
        ser.open()
    except serial.SerialException as err:
        print(str(err))
        sys.exit(1)

    sendCommand(ser, 254)
    print("Save screen image:")
    if (readRadioInfo(ser) == True):
        if (platformModel == PlatformModels.PLATFORM_UNKNOWN):
            print("Failure: unsupported platform.")
            sys.exit(1)

        print("     * Platform is:", PlatformsNames[int(platformModel)])

        if (sendAndReceiveCommand(ser) == True):
            saveImage(filename, scale, foreground, background)
            print("Done.")
        else:
            print("Failure")
    else:
        print("Failure")

    if (ser.is_open):
        sendCommand(ser, 7)
        ser.close()


###
# Calling main function
###
main()
sys.exit(0)
