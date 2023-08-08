build:
	rm -f ./main.js ChatGPTx.popclipextz
	tsc || exit 0
	pushd .. && zip -r ChatGPTx.popclipextz ChatGPTx.popclipext -x *.git* && mv ChatGPTx.popclipextz ChatGPTx.popclipext && popd
