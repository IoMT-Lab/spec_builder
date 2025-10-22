# Installation Dependencies Script

This project provides a script to install necessary dependencies for the project on both macOS and Ubuntu systems.

## Prerequisites

- Ensure you have the necessary permissions to install packages on your system.
- For macOS, you need to have Homebrew installed. You can install it by running the following command in your terminal:

  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```

- For Ubuntu, you should have `sudo` privileges to install packages.

## Usage

To run the installation script, follow these steps:

1. Open your terminal.
2. Navigate to the project directory:

   ```bash
   cd path/to/install-deps-scripts
   ```

3. Make the script executable:

   ```bash
   chmod +x scripts/install-deps.sh
   ```

4. Run the installation script:

   ```bash
   ./scripts/install-deps.sh
   ```

The script will automatically detect your operating system and install the required dependencies accordingly.

## Supported Operating Systems

- macOS
- Ubuntu

## Troubleshooting

If you encounter any issues while running the script, please check the following:

- Ensure you have an active internet connection.
- Verify that you have the necessary permissions to install packages.
- Check for any error messages in the terminal for guidance on resolving issues.

Feel free to contribute to this project by submitting issues or pull requests.