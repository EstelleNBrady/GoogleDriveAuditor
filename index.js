import csv
import os
from google.oauth2 import service_account
from googleapiclient.discovery import build
from dotenv import load_dotenv

# === LOAD ENV VARIABLES ===
load_dotenv()  # Reads variables from .env file

SERVICE_ACCOUNT_FILE = os.getenv('SERVICE_ACCOUNT_FILE')
SHARED_DRIVE_ID = os.getenv('SHARED_DRIVE_ID')
CSV_OUTPUT_FILE = os.getenv('CSV_OUTPUT_FILE')
IMPERSONATE_USER = os.getenv('IMPERSONATE_USER')

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

# === AUTH ===
credentials = service_account.Credentials.from_service_account_file(
    SERVICE_ACCOUNT_FILE, scopes=SCOPES)
delegated_creds = credentials.with_subject(IMPERSONATE_USER)
drive_service = build('drive', 'v3', credentials=delegated_creds)

# === HELPERS ===
def list_drive_files(shared_drive_id):
    all_files = []
    folder_stack = []
    folder_paths = {}

    response = drive_service.files().list(
        q=f"'{shared_drive_id}' in parents and mimeType = 'application/vnd.google-apps.folder'",
        corpora='drive',
        driveId=shared_drive_id,
        includeItemsFromAllDrives=True,
        supportsAllDrives=True,
        fields="files(id, name)",
        pageSize=1000
    ).execute()

    for folder in response.get('files', []):
        folder_stack.append(folder['id'])
        folder_paths[folder['id']] = folder['name']

    while folder_stack:
        current_folder_id = folder_stack.pop()
        current_path = folder_paths[current_folder_id]

        page_token = None
        while True:
            response = drive_service.files().list(
                q=f"'{current_folder_id}' in parents and trashed = false",
                corpora='drive',
                driveId=shared_drive_id,
                includeItemsFromAllDrives=True,
                supportsAllDrives=True,
                fields="nextPageToken, files(id, name, mimeType)",
                pageSize=1000,
                pageToken=page_token
            ).execute()

            for file in response.get('files', []):
                file_id = file['id']
                file_name = file['name']
                mime_type = file['mimeType']
                full_path = os.path.join(current_path, file_name)
                file['full_path'] = full_path
                all_files.append(file)

                if mime_type == 'application/vnd.google-apps.folder':
                    folder_stack.append(file_id)
                    folder_paths[file_id] = full_path

            page_token = response.get('nextPageToken', None)
            if not page_token:
                break

    return all_files

def get_permissions(file_id):
    try:
        permissions = drive_service.permissions().list(
            fileId=file_id,
            supportsAllDrives=True,
            fields="permissions(id, type, emailAddress, role, displayName, permissionDetails)"
        ).execute()
        return permissions.get('permissions', [])
    except Exception as e:
        print(f"Error fetching permissions for file {file_id}: {e}")
        return []

# === MAIN LOGIC ===
def audit_drive(shared_drive_id, output_csv):
    all_files = list_drive_files(shared_drive_id)

    with open(output_csv, mode='w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['File Name', 'File ID', 'User/Group', 'Type', 'Role', 'Inherited'])

        for file in all_files:
            file_id = file['id']
            file_name = file.get('full_path', file['name'])

            permissions = get_permissions(file_id)
            for perm in permissions:
                permission_details = perm.get('permissionDetails', [{}])[0]
                inherited = permission_details.get('inherited', True)

                if inherited:
                    continue  # Skip inherited permissions

                email = perm.get('emailAddress', perm.get('displayName', 'N/A'))
                writer.writerow([
                    file_name,
                    file_id,
                    email,
                    perm.get('type', ''),
                    perm.get('role', ''),
                    str(inherited)
                ])

    print(f"Audit complete! CSV saved to {output_csv}")

# === RUN ===
if __name__ == '__main__':
    audit_drive(SHARED_DRIVE_ID, CSV_OUTPUT_FILE)
